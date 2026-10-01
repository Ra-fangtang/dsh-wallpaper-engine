// ============================================================================
// scene-pkg —— 从 Wallpaper Engine 的 scene.pkg 里取出「真实画面」
// ----------------------------------------------------------------------------
// 场景壁纸的画面在 scene.pkg 里，浏览器没有能渲染它的东西；官方预览图只是 Steam
// 创意工坊的封面缩略图（实测 160×160 ~ 1024×1024），据此铺屏会又糊又裁。
// 本模块把 pkg 里的纹理解出来：内嵌的 PNG/JPEG/MP4 原样直出，裸像素（RGBA8888 /
// DXT1/3/5，可能带 LZ4 压缩）自己解码并编码成 PNG。
//
// 格式来源：Wallpaper Engine 私有容器，结构按 RePKG（MIT）的实现逐一核对过：
//   pkg : u32 版本串长 | "PKGV00xx" | u32 条目数 | 条目数 × { u32 路径长 | 路径 | u32 偏移 | u32 长度 }
//         数据位置 = 条目表末尾 + 偏移（不是文件开头 + 偏移）
//   tex : "TEXV0005\0" | "TEXI0001\0" | u32 格式 | u32 flags | u32 纹理宽高 | u32 图像宽高 | u32 未知
//         | "TEXB000x\0" | u32 图像数 | 每图 { u32 mip 数 | 每 mip {...} }
//         魔数与容器名都是「读到 \0 为止」的定长串，不是长度前缀串 —— 这点搞错会在
//         第一个字节就解析失败（0x56584554 正是 "TEXV" 的小端读法）。
//   TEXB0001/0002：mip = 宽 高 长度 数据
//   TEXB0003    ：带 u32 FreeImage 编码（PNG/JPEG/MP4…）
//   TEXB0004    ：多一段条件串；非 MP4 时按 0003 处理
//   TEXB0002/0003 的 mip 带 u32 isLZ4 + u32 解压后长度
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------------------------------------------------------------------------
// pkg 容器
// ---------------------------------------------------------------------------
export function parsePkg (buf) {
  let o = 0
  const versionLen = buf.readUInt32LE(o); o += 4
  const version = buf.toString('utf8', o, o + versionLen); o += versionLen
  if (!/^PKGV\d{4}$/.test(version)) throw new Error('不是 Wallpaper Engine 的 pkg：版本串 ' + JSON.stringify(version))
  const count = buf.readUInt32LE(o); o += 4
  if (count <= 0 || count > 200000) throw new Error('条目数不合理：' + count)
  const entries = []
  for (let i = 0; i < count; i++) {
    if (o + 12 > buf.length) throw new Error('条目表越界 @' + o)
    const pathLen = buf.readUInt32LE(o); o += 4
    if (pathLen < 1 || pathLen > 512 || o + pathLen + 8 > buf.length) throw new Error('第 ' + i + ' 条路径长度不合理：' + pathLen)
    const name = buf.toString('utf8', o, o + pathLen); o += pathLen
    const offset = buf.readUInt32LE(o); o += 4
    const length = buf.readUInt32LE(o); o += 4
    entries.push({ name, offset, length })
  }
  const headerSize = o
  for (const e of entries) {
    e.at = headerSize + e.offset
    if (e.at + e.length > buf.length) throw new Error('条目越界：' + e.name)
  }
  return { version, headerSize, entries, buf }
}

// ---------------------------------------------------------------------------
// tex 容器
// ---------------------------------------------------------------------------
const TEX_FORMAT = { 0: 'RGBA8888', 4: 'DXT5', 6: 'DXT3', 7: 'DXT1', 8: 'RG88', 9: 'R8' }

/** 读到 \0 为止的定长串（RePKG 的 ReadNString）。 */
function readNString (buf, state, max) {
  let s = ''
  while (state.o < buf.length && s.length < max) {
    const c = buf[state.o++]
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

export function parseTex (buf) {
  const st = { o: 0 }
  const i32 = () => { const v = buf.readInt32LE(st.o); st.o += 4; return v }
  const magic1 = readNString(buf, st, 16)
  if (magic1 !== 'TEXV0005') throw new Error('不是 TEXV0005：' + JSON.stringify(magic1))
  const magic2 = readNString(buf, st, 16)
  if (magic2 !== 'TEXI0001') throw new Error('不是 TEXI0001：' + JSON.stringify(magic2))
  const format = i32()
  const flags = i32()
  const texW = i32()
  const texH = i32()
  const imgW = i32()
  const imgH = i32()
  const unk = i32()
  const container = readNString(buf, st, 16)
  const imageCount = i32()
  if (imageCount < 0 || imageCount > 4096) throw new Error('图像数不合理：' + imageCount)
  let version = Number(container.slice(4))
  if (!(version >= 1 && version <= 4)) throw new Error('不认识的容器：' + JSON.stringify(container))
  let imageFormat = null
  let videoMp4 = false
  if (version === 3) imageFormat = i32()
  else if (version === 4) {
    imageFormat = i32()
    videoMp4 = i32() === 1
    if (imageFormat === 0 && videoMp4) imageFormat = 6
  }
  if (version === 4 && imageFormat !== 6) version = 3    // RePKG 的同款降级：非 MP4 的 V4 按 V3 读
  const images = []
  for (let i = 0; i < imageCount; i++) {
    const mipCount = i32()
    if (mipCount < 0 || mipCount > 64) throw new Error('mip 数不合理：' + mipCount)
    const mips = []
    for (let m = 0; m < mipCount; m++) {
      if (version === 4) {
        // V4 在 宽高 之前有 4 个 u32 的前导字段。RePKG 把它们校验成常量 1/2/1，
        // 但实测它们随纹理而变（同一份 pkg 里出现过 1,13,0,1 与 1,-8,0,5），
        // 硬校验会把整条纹理丢掉 —— 本机 9 张 DXT 壁纸正是这样全灭的。
        // 这里只跳过，不校验；正确性交给后面「尺寸 × 每像素字节数」的验收。
        st.o += 16
      }
      const w = i32()
      const h = i32()
      let isLz4 = false
      let decompressed = 0
      if (version >= 2) { isLz4 = i32() === 1; decompressed = i32() }
      const byteCount = i32()
      if (byteCount < 0 || st.o + byteCount > buf.length) throw new Error('mip 数据越界')
      const bytes = buf.subarray(st.o, st.o + byteCount)
      st.o += byteCount
      mips.push({ w, h, isLz4, decompressed, bytes })
    }
    images.push({ mipCount, mips })
  }
  return {
    format, formatName: TEX_FORMAT[format] || String(format), flags,
    texW, texH, imgW, imgH, unk, container, version, imageFormat, videoMp4, imageCount, images,
  }
}

// ---------------------------------------------------------------------------
// LZ4 块解压（无帧头，WE 就是这么存 mipmap 的）
// ---------------------------------------------------------------------------
export function lz4Decompress (src, expectedSize) {
  const dst = Buffer.alloc(expectedSize)
  let s = 0
  let d = 0
  while (s < src.length) {
    const token = src[s++]
    let lit = token >> 4
    if (lit === 15) { let b; do { b = src[s++]; lit += b } while (b === 255) }
    if (lit > 0) {
      if (s + lit > src.length || d + lit > expectedSize) throw new Error('LZ4 字面量越界')
      src.copy(dst, d, s, s + lit)
      s += lit
      d += lit
    }
    if (s >= src.length) break                 // 最后一段没有匹配
    const offset = src[s] | (src[s + 1] << 8)
    s += 2
    if (offset === 0 || offset > d) throw new Error('LZ4 匹配偏移非法：' + offset)
    let mlen = token & 0x0f
    if (mlen === 15) { let b; do { b = src[s++]; mlen += b } while (b === 255) }
    mlen += 4
    if (d + mlen > expectedSize) throw new Error('LZ4 输出越界')
    let from = d - offset
    for (let i = 0; i < mlen; i++) dst[d++] = dst[from++]
  }
  if (d !== expectedSize) throw new Error('LZ4 产出 ' + d + ' 字节，应为 ' + expectedSize)
  return dst
}

// ---------------------------------------------------------------------------
// 裸像素 → PNG（零依赖：zlib 压缩 + 自己写 PNG 块与 CRC32）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'latin1')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** rgb: 每像素 3 字节的 RGB 缓冲 → PNG 缓冲。 */
export function encodePng (rgb, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0                                      // 每行滤波器 = None
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8       // 位深
  ihdr[9] = 2       // 颜色类型：真彩 RGB
  ihdr[10] = 0      // 压缩
  ihdr[11] = 0      // 滤波
  ihdr[12] = 0      // 逐行扫描
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 裸像素 → RGB 缓冲。支持 RGBA8888/BGRA 与 DXT1/3/5；未知格式返回 null。 */
export function decodePixels (data, format, width, height) {
  switch (format) {
    case 0: return rgbaToRgb(data, width, height)          // RGBA8888
    case 7: return dxtToRgb(data, width, height, 1)        // DXT1
    case 6: return dxtToRgb(data, width, height, 3)        // DXT3
    case 4: return dxtToRgb(data, width, height, 5)        // DXT5
    default: return null
  }
}

function rgbaToRgb (data, width, height) {
  const need = width * height * 4
  if (data.length < need) return null
  const out = Buffer.alloc(width * height * 3)
  for (let i = 0, j = 0; i < need; i += 4, j += 3) {
    out[j] = data[i]
    out[j + 1] = data[i + 1]
    out[j + 2] = data[i + 2]
  }
  return out
}

// --- DXT / BC 解码 -----------------------------------------------------------
function color565 (v) {
  const r = (v >> 11) & 0x1f
  const g = (v >> 5) & 0x3f
  const b = v & 0x1f
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

function dxtToRgb (data, width, height, kind) {
  const bw = Math.ceil(width / 4)
  const bh = Math.ceil(height / 4)
  const blockBytes = kind === 1 ? 8 : 16
  if (data.length < bw * bh * blockBytes) return null
  const out = Buffer.alloc(width * height * 3)
  let p = 0
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const blockStart = p
      p += blockBytes
      let alpha = null
      let colorAt = blockStart
      if (kind === 3) {
        // DXT3：前 8 字节是 4 位显式 alpha
        alpha = new Array(16)
        for (let i = 0; i < 16; i++) {
          const byte = data[blockStart + (i >> 1)]
          const nib = (i & 1) ? (byte >> 4) : (byte & 0x0f)
          alpha[i] = nib * 17
        }
        colorAt = blockStart + 8
      } else if (kind === 5) {
        // DXT5：前 8 字节是 alpha 端点 + 3 位索引
        const a0 = data[blockStart]
        const a1 = data[blockStart + 1]
        const table = [a0, a1]
        if (a0 > a1) { for (let i = 1; i <= 6; i++) table.push(Math.round(((7 - i) * a0 + i * a1) / 7)) }
        else { for (let i = 1; i <= 4; i++) table.push(Math.round(((5 - i) * a0 + i * a1) / 5)); table.push(0); table.push(255) }
        alpha = new Array(16)
        for (let i = 0; i < 16; i++) {
          const bitPos = i * 3
          const byteIdx = blockStart + 2 + (bitPos >> 3)
          const shift = bitPos & 7
          let idx = data[byteIdx] >> shift
          if (shift > 5) idx |= data[byteIdx + 1] << (8 - shift)
          alpha[i] = table[idx & 0x07]
        }
        colorAt = blockStart + 8
      }
      const c0 = data[colorAt] | (data[colorAt + 1] << 8)
      const c1 = data[colorAt + 2] | (data[colorAt + 3] << 8)
      const rgb0 = color565(c0)
      const rgb1 = color565(c1)
      const pal = [rgb0, rgb1, null, null]
      if (kind === 1 && c0 <= c1) {
        pal[2] = [(rgb0[0] + rgb1[0]) >> 1, (rgb0[1] + rgb1[1]) >> 1, (rgb0[2] + rgb1[2]) >> 1]
        pal[3] = [0, 0, 0]                                   // 透明
      } else {
        pal[2] = [Math.round((2 * rgb0[0] + rgb1[0]) / 3), Math.round((2 * rgb0[1] + rgb1[1]) / 3), Math.round((2 * rgb0[2] + rgb1[2]) / 3)]
        pal[3] = [Math.round((rgb0[0] + 2 * rgb1[0]) / 3), Math.round((rgb0[1] + 2 * rgb1[1]) / 3), Math.round((rgb0[2] + 2 * rgb1[2]) / 3)]
      }
      const bits = data.readUInt32LE(colorAt + 4)
      for (let i = 0; i < 16; i++) {
        const px = bx * 4 + (i & 3)
        const py = by * 4 + (i >> 2)
        if (px >= width || py >= height) continue
        const idx = (bits >> (2 * i)) & 0x03
        const c = pal[idx] || [0, 0, 0]
        // DXT1 的透明索引 → 用黑色近似（JPEG/PNG 里没法带 1 位 alpha）
        const o = (py * width + px) * 3
        out[o] = c[0]
        out[o + 1] = c[1]
        out[o + 2] = c[2]
      }
      // alpha 这里不参与（输出 RGB），仅解析以保证块指针正确
      void alpha
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 载荷识别与「挑画面」
// ---------------------------------------------------------------------------
export function sniff (data) {
  if (!data || data.length < 12) return 'empty'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  if (data.toString('latin1', 0, 3) === 'GIF') return 'gif'
  return 'raw'
}

/**
 * 抽样估计一块 RGBA 画布里「不透明像素」的占比。
 * 用途：场景里很多大尺寸纹理其实是透明背景上的一个小精灵（花瓣、光斑、UI 元素），
 * 按面积排它们会排到第一，但铺到屏幕上就是一片黑。只看 alpha 就够了。
 */
export function opaqueRatio (data, width, height, samples) {
  const n = Math.min(samples || 4096, width * height)
  if (!n) return 1
  let opaque = 0
  let seen = 0
  const step = Math.max(1, Math.floor((width * height) / n))
  for (let p = 0; p < width * height; p += step) {
    const a = data[p * 4 + 3]
    if (a === undefined) return 1                  // 不是 RGBA，判不了就不惩罚
    if (a > 24) opaque++
    seen++
  }
  return seen ? opaque / seen : 1
}

/**
 * 内嵌 PNG 的不透明像素占比：只解 IDAT（zlib + 反滤波）读 alpha，不解颜色。
 * 场景里的大尺寸透明精灵同样会骗过「按面积挑」，所以内嵌图片也要测一测。
 * 解不出来（调色板 / 隔行 / 读一半出错）就返回 null —— 不惩罚。
 */
export function pngOpaqueRatio (data) {
  try {
    let o = 8
    let width = 0
    let height = 0
    let bitDepth = 8
    let colorType = 6
    let interlace = 0
    const idat = []
    // 按块头逐块走：长度 + 类型 + 数据 + 4 字节 CRC。
    // 不用「找不到就放弃」的写法 —— 有的 PNG 带非标准附加块，跳错一步就再也读不到 IDAT。
    while (o + 8 <= data.length) {
      const len = data.readUInt32BE(o)
      const type = data.toString('latin1', o + 4, o + 8)
      if (len > data.length - o - 12) break                 // 块长度不合理：文件到此为止
      if (type === 'IHDR' && len >= 13) {
        const body = data.subarray(o + 8, o + 8 + len)
        width = body.readUInt32BE(0)
        height = body.readUInt32BE(4)
        bitDepth = body[8]
        colorType = body[9]
        interlace = body[12]
      } else if (type === 'IDAT') {
        idat.push(data.subarray(o + 8, o + 8 + len))
      } else if (type === 'IEND') {
        break
      }
      o += 12 + len
    }
    if (!width || !height || interlace !== 0 || bitDepth !== 8) return null
    // 只有带 alpha 的两种真彩色格式能这样测；调色板/灰度/无 alpha 的直接放过
    if (colorType !== 6 && colorType !== 4) return null
    const channels = colorType === 6 ? 4 : 2
    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = width * channels
    if (raw.length < (stride + 1) * height) return null
    const prev = Buffer.alloc(stride)
    const cur = Buffer.alloc(stride)
    const stepY = Math.max(1, Math.floor(height / 64))
    const stepX = Math.max(1, Math.floor(width / 64))
    let opaque = 0
    let total = 0
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      raw.copy(cur, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? cur[i - channels] : 0
        const b = prev[i]
        const c = i >= channels ? prev[i - channels] : 0
        let v = cur[i]
        if (filter === 1) v = (v + a) & 0xff
        else if (filter === 2) v = (v + b) & 0xff
        else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
        else if (filter === 4) {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
        }
        cur[i] = v
      }
      if (y % stepY === 0) {
        for (let x = 0; x < width; x += stepX) {
          if (cur[x * channels + channels - 1] > 24) opaque++
          total++
        }
      }
      cur.copy(prev)
    }
    return total ? opaque / total : null
  } catch (error) {
    return null
  }
}

/** 画面评分：越像「一张铺满屏幕的壁纸」分越高。 */
export function scoreCandidate (c) {
  let s = Math.log2(Math.max(1, c.area))
  const ar = c.width / Math.max(1, c.height)
  if (ar >= 1.2 && ar <= 2.8) s += 6                    // 横向构图（含 21:9 这类超宽幅）
  else if (ar > 0.85 && ar < 1.2) s += 2.5              // 正方形：还能用
  else if (ar < 0.85) s -= 3                            // 竖图
  else s -= 0.5                                         // 极端超宽
  if (typeof c.opaque === 'number') {
    if (c.opaque < 0.06) s -= 12                        // 基本全透明 → 精灵图，压到底
    else if (c.opaque < 0.25) s -= 6
    else if (c.opaque > 0.85) s += 1.5                  // 整幅不透明 → 多半是背景板
  }
  // 内嵌图片/视频不用解码，优先一点点；但这只是偏好，压不过画面本身的差距
  if (c.kind === 'mp4' || c.kind === 'png' || c.kind === 'jpeg' || c.kind === 'gif') s += 0.6
  return s
}

/**
 * 从 scene.pkg 里挑出「最像壁纸画面」的一份资源。
 * 规则（按此顺序）：内嵌视频 > 内嵌图片 > 面积最大的裸像素。
 * @returns {{kind:string, ext:string, data:Buffer|null, width:number, height:number, entry:string, format:string, note:string, png:Buffer|null}}
 */
export function extractLargestMedia (pkgPath) {
  const buf = fs.readFileSync(pkgPath)
  const pkg = parsePkg(buf)
  const candidates = []
  for (const entry of pkg.entries) {
    if (!/\.tex$/i.test(entry.name)) continue
    let tex
    try { tex = parseTex(buf.subarray(entry.at, entry.at + entry.length)) } catch (error) {
      candidates.push({ entry, error: error.message })
      continue
    }
    for (const image of tex.images) {
      for (let i = 0; i < image.mips.length; i++) {
        const mip = image.mips[i]
        let data = mip.bytes
        let decompressed = false
        if (mip.isLz4) {
          try { data = lz4Decompress(data, mip.decompressed); decompressed = true } catch (error) { continue }
        }
        const kind = sniff(data)
        const w = tex.imgW || mip.w
        const h = tex.imgH || mip.h
        const candidate = {
          entry, tex, mip, mipIndex: i, kind, data, decompressed, width: w, height: h,
          area: w * h, format: tex.formatName,
        }
        // 透明精灵图会骗过「按面积挑」：裸像素看 alpha，内嵌 PNG 解 alpha 通道
        if (kind === 'raw' && w > 0 && h > 0 && data.length >= w * h * 4) {
          candidate.opaque = opaqueRatio(data, w, h)
        } else if (kind === 'png') {
          const ratio = pngOpaqueRatio(data)
          if (ratio != null) candidate.opaque = ratio
        }
        candidates.push(candidate)
      }
    }
  }
  const usable = candidates.filter((c) => !c.error && c.kind !== 'empty')
  // 所有候选统一评分排序：不再按载荷种类分层 —— 那样会让一张 600×600 的透明精灵
  // 压过 3840×2208 的真实背景（本机 Blue Archive 那张就是这么错的）。
  usable.forEach((c) => { c.__score = scoreCandidate(c) })
  usable.sort((a, b) => b.__score - a.__score)
  const chosen = usable[0] || null
  if (!chosen) {
    return { pkgVersion: pkg.version, entries: pkg.entries.length, failures: candidates.filter((c) => c.error).length, failed: true }
  }
  // 裸像素就地解码成 PNG，宿主侧只需按扩展名发文件
  if (chosen.kind === 'raw') {
    const rgb = decodePixels(chosen.data, chosen.tex.format, chosen.width, chosen.height)
    if (!rgb) {
      return {
        pkgVersion: pkg.version, entries: pkg.entries.length, failed: true,
        failures: candidates.filter((c) => c.error).length,
        reason: '纹理格式 ' + chosen.format + '（' + chosen.width + '×' + chosen.height + '）暂不支持解码',
      }
    }
    chosen.png = encodePng(rgb, chosen.width, chosen.height)
  }
  return {
    pkgVersion: pkg.version,
    entries: pkg.entries.length,
    failures: candidates.filter((c) => c.error).length,
    failed: false,
    kind: chosen.kind === 'raw' ? 'png' : chosen.kind,
    ext: chosen.kind === 'raw' ? 'png' : chosen.kind,
    data: chosen.png || chosen.data,
    bitmapOnly: chosen.kind === 'raw',
    width: chosen.width,
    height: chosen.height,
    entry: chosen.entry.name,
    format: chosen.format,
    mipIndex: chosen.mipIndex,
    decompressed: chosen.decompressed,
    candidateCount: usable.length,
    opaque: typeof chosen.opaque === 'number' ? Math.round(chosen.opaque * 1000) / 1000 : null,
    /** 候选排行（诊断用：规则挑错了能一眼看出下一个是谁）。 */
    top: usable.slice(0, 5).map((c) => ({
      entry: c.entry.name, kind: c.kind, size: c.width + 'x' + c.height,
      area: c.area, opaque: typeof c.opaque === 'number' ? Math.round(c.opaque * 1000) / 1000 : null,
      score: Math.round(c.__score * 10) / 10,
    })),
  }
}

/** 只读摘要，供诊断输出。 */
export function describe (pkgPath) {
  const r = extractLargestMedia(pkgPath)
  if (r.failed) return { ok: false, reason: r.reason || '没有可用的纹理载荷', pkgVersion: r.pkgVersion, failures: r.failures }
  return {
    ok: true, pkgVersion: r.pkgVersion, entry: r.entry, kind: r.kind, format: r.format,
    size: r.width + 'x' + r.height, bytes: r.data.length, candidates: r.candidateCount, failures: r.failures,
    decompressed: r.decompressed, opaque: r.opaque, top: r.top,
  }
}
