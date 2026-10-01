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
  let previewCheck = null
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
    // 解码出来的像素正好用来和作者预览图比色比构图（DXT 这条路以前漏了，
    // 于是「圣园未花」那种多层场景的 mismatch 判定根本拿不到）
    previewCheck = checkAgainstPreview(pkgPath, {
      bins: rgbHistogram(rgb, chosen.width, chosen.height),
      luma: lumaGrid(rgb, chosen.width, chosen.height),
    }, path.dirname(pkgPath))
  } else if (chosen.kind === 'png') {
    const got = pngToRgb(chosen.data)
    if (got) previewCheck = checkAgainstPreview(pkgPath, { bins: rgbHistogram(got.rgb, got.width, got.height), luma: lumaGrid(got.rgb, got.width, got.height) }, path.dirname(pkgPath))
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
    previewCheck: previewCheck,
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

// ---------------------------------------------------------------------------
// 「这一层到底像不像最终画面」——和作者的预览图比颜色分布
// ---------------------------------------------------------------------------
// 多层拼接 / 鼠标跟随的场景（本机「圣园未花」就是），任何单层都不等于合成结果：
// 实测它最大的层是纯夜空、候选第一名干脆是一条横向拖影，而作者给的预览图才是对的合成图。
// 所以取完画面后，把它和预览图各缩成 32×32、算 4×4×4 的颜色直方图比相似度；
// 不像就退回预览图 —— 宁可糊一点，也不要显示错的东西。

/** 把 RGB 缓冲缩成 size×size（盒式降采样）。 */
function downscaleRgb (rgb, width, height, size) {
  const out = new Uint8Array(size * size * 3)
  const sx = width / size
  const sy = height / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      const y0 = Math.floor(y * sy)
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
      const stepX = Math.max(1, Math.floor((x1 - x0) / 8))
      const stepY = Math.max(1, Math.floor((y1 - y0) / 8))
      for (let yy = y0; yy < y1 && yy < height; yy += stepY) {
        for (let xx = x0; xx < x1 && xx < width; xx += stepX) {
          const o = (yy * width + xx) * 3
          r += rgb[o]
          g += rgb[o + 1]
          b += rgb[o + 2]
          n++
        }
      }
      const o = (y * size + x) * 3
      out[o] = n ? Math.round(r / n) : 0
      out[o + 1] = n ? Math.round(g / n) : 0
      out[o + 2] = n ? Math.round(b / n) : 0
    }
  }
  return out
}

/** 4×4×4 颜色直方图（归一化，64 个桶）。 */
function histogram (rgb, size) {
  const bins = new Float32Array(64)
  let total = 0
  for (let i = 0; i < size * size; i++) {
    const o = i * 3
    const idx = ((rgb[o] >> 6) << 4) | ((rgb[o + 1] >> 6) << 2) | (rgb[o + 2] >> 6)
    bins[idx]++
    total++
  }
  if (total) for (let i = 0; i < 64; i++) bins[i] /= total
  return bins
}

/** 直方图交集：0..1，1 = 颜色分布完全一致。 */
export function histogramSimilarity (a, b) {
  let inter = 0
  for (let i = 0; i < 64; i++) inter += Math.min(a[i], b[i])
  return inter
}

/**
 * 16×16 亮度网格：比颜色直方图更能看出「内容对不对」。
 * 颜色分布对「同一色调、不同构图」几乎无感 —— 实测圣园未花的夜空层和它的预览图
 * 颜色相似度高达 0.746，但构图（角色在不在）完全是两码事。
 * 亮度网格会把「哪里亮、哪里暗」一起比进去，这类错位就掉下来了。
 */
function lumaGrid (rgb, width, height) {
  const N = 16
  const g = new Float32Array(N * N)
  const sx = width / N
  const sy = height / N
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let sum = 0
      let n = 0
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      const y0 = Math.floor(y * sy)
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
      const stepX = Math.max(1, Math.floor((x1 - x0) / 6))
      const stepY = Math.max(1, Math.floor((y1 - y0) / 6))
      for (let yy = y0; yy < y1 && yy < height; yy += stepY) {
        for (let xx = x0; xx < x1 && xx < width; xx += stepX) {
          const o = (yy * width + xx) * 3
          sum += (rgb[o] * 299 + rgb[o + 1] * 587 + rgb[o + 2] * 114) / 1000
          n++
        }
      }
      g[y * N + x] = n ? sum / n : 0
    }
  }
  return g
}

/** 亮度网格的结构相似度：1 - 归一化平均绝对差。 */
function lumaSimilarity (a, b) {
  let diff = 0
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  return Math.max(0, 1 - diff / (a.length * 255))
}

/** 内嵌 PNG → RGB 缓冲（非隔行、8 位；够用来比色）。 */
function pngToRgb (data) {
  try {
    let o = 8
    let width = 0
    let height = 0
    let bitDepth = 8
    let colorType = 6
    let interlace = 0
    const idat = []
    while (o + 8 <= data.length) {
      const len = data.readUInt32BE(o)
      const type = data.toString('latin1', o + 4, o + 8)
      if (len > data.length - o - 12) break
      if (type === 'IHDR') {
        const body = data.subarray(o + 8, o + 8 + len)
        width = body.readUInt32BE(0)
        height = body.readUInt32BE(4)
        bitDepth = body[8]
        colorType = body[9]
        interlace = body[12]
      } else if (type === 'IDAT') idat.push(data.subarray(o + 8, o + 8 + len))
      else if (type === 'IEND') break
      o += 12 + len
    }
    if (!width || !height || interlace !== 0 || bitDepth !== 8) return null
    if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) return null
    const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
    const raw = zlib.inflateSync(Buffer.concat(idat))
    const stride = width * ch
    if (raw.length < (stride + 1) * height) return null
    const out = Buffer.alloc(width * height * 3)
    const prev = Buffer.alloc(stride)
    const cur = Buffer.alloc(stride)
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      raw.copy(cur, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0
        const b = prev[i]
        const c = i >= ch ? prev[i - ch] : 0
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
      for (let x = 0; x < width; x++) {
        const s = x * ch
        const t = (y * width + x) * 3
        if (ch >= 3) { out[t] = cur[s]; out[t + 1] = cur[s + 1]; out[t + 2] = cur[s + 2] }
        else { out[t] = out[t + 1] = out[t + 2] = cur[s] }
      }
      cur.copy(prev)
    }
    return { rgb: out, width, height }
  } catch (error) {
    return null
  }
}

/**
 * GIF 首帧 → RGB（LZW + 调色板）。只解第一帧，够用来和提取结果比色。
 * 不处理隔行（GIF 的 interlace 标记）——那种情况返回 null，交给调用方按尺寸兜底。
 */
function gifFirstFrameRgb (data) {
  try {
    if (data.toString('latin1', 0, 3) !== 'GIF') return null
    let o = 6
    const flags = data[o + 4]
    o += 7
    let palette = null
    if (flags & 0x80) {
      const n = 1 << ((flags & 0x07) + 1)
      palette = data.subarray(o, o + n * 3)
      o += n * 3
    }
    const lzw = (minCodeSize, chunkData) => {
      const clear = 1 << minCodeSize
      const end = clear + 1
      let codeSize = minCodeSize + 1
      let dict = []
      const reset = () => {
        dict = []
        for (let i = 0; i < clear; i++) dict.push([i])
        dict.push(null)              // clear
        dict.push(null)              // end
        codeSize = minCodeSize + 1
      }
      reset()
      const out = []
      let bitBuf = 0
      let bitCount = 0
      let prev = null
      for (let i = 0; i < chunkData.length; i++) {
        bitBuf |= chunkData[i] << bitCount
        bitCount += 8
        while (bitCount >= codeSize) {
          const code = bitBuf & ((1 << codeSize) - 1)
          bitBuf >>= codeSize
          bitCount -= codeSize
          if (code === clear) { reset(); prev = null; continue }
          if (code === end) return out
          let entry
          if (code < dict.length && dict[code]) entry = dict[code]
          else if (prev) entry = prev.concat([prev[0]])
          else return out
          for (const v of entry) out.push(v)
          if (prev) {
            dict.push(prev.concat([entry[0]]))
            if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++
          }
          prev = entry
        }
      }
      return out
    }
    while (o < data.length) {
      const block = data[o++]
      if (block === 0x21) {                      // 扩展块：跳过
        o++
        while (o < data.length) { const n = data[o++]; if (!n) break; o += n }
        continue
      }
      if (block === 0x2c) {                      // 图像描述符 → 第一帧
        const left = data.readUInt16LE(o); o += 2
        const top = data.readUInt16LE(o); o += 2
        const w = data.readUInt16LE(o); o += 2
        const h = data.readUInt16LE(o); o += 2
        const lflags = data[o++]
        const interlace = !!(lflags & 0x40)
        let localPal = palette
        if (lflags & 0x80) {
          const n = 1 << ((lflags & 0x07) + 1)
          localPal = data.subarray(o, o + n * 3)
          o += n * 3
        }
        const minCode = data[o++]
        const parts = []
        while (o < data.length) { const n = data[o++]; if (!n) break; parts.push(data.subarray(o, o + n)); o += n }
        if (interlace) return null
        const idx = lzw(minCode, Buffer.concat(parts))
        if (!localPal || idx.length < w * h) return null
        const out = Buffer.alloc(w * h * 3)
        for (let i = 0; i < w * h; i++) {
          const p = idx[i] * 3
          out[i * 3] = localPal[p]
          out[i * 3 + 1] = localPal[p + 1]
          out[i * 3 + 2] = localPal[p + 2]
        }
        void left
        void top
        return { rgb: out, width: w, height: h }
      }
      break                                      // 0x3b 结束符或其他
    }
    return null
  } catch (error) {
    return null
  }
}

/** 预览图 → 直方图 + 亮度网格。PNG 解全图、GIF 解首帧；JPEG 需要完整解码器，解不了返回 null。 */
export function previewHistogram (file) {
  try {
    if (fs.statSync(file).size > 24 * 1024 * 1024) return null
    const data = fs.readFileSync(file)
    const kind = sniff(data)
    let got = null
    if (kind === 'png') got = pngToRgb(data)
    else if (kind === 'gif') got = gifFirstFrameRgb(data)
    if (!got) return null
    return {
      bins: histogram(downscaleRgb(got.rgb, got.width, got.height, 32), 32),
      luma: lumaGrid(got.rgb, got.width, got.height),
      width: got.width, height: got.height,
    }
  } catch (error) {
    return null
  }
}

/** 已解码的 RGB 缓冲 → 直方图。 */
export function rgbHistogram (rgb, width, height) {
  return histogram(downscaleRgb(rgb, width, height, 32), 32)
}

/**
 * 取完画面后判断「它像不像作者的预览图」。两个判据一起用，取更差的那个：
 *   颜色直方图交集（管整体色调）+ 16×16 亮度网格相似度（管构图）。
 * 阈值 0.45 是实测出来的：真正的单层合成图两类相似度都在 0.9 以上（ATRI 场景 = 1.0），
 * 而「圣园未花」抓到的夜空层颜色像、构图不像，亮度网格会把它压下来。
 * @returns {{similarity:number|null, lumaSimilarity:number|null, preview:object|null, verdict:string}}
 */
export function checkAgainstPreview (pkgPath, chosen, projectDir) {
  let preview = null
  for (const cand of ['preview.png', 'preview.jpg', 'preview.gif']) {
    const p = path.join(projectDir, cand)
    if (fs.existsSync(p)) { preview = { path: p, file: cand }; break }
  }
  if (!preview || !chosen || !chosen.bins) return { similarity: null, lumaSimilarity: null, preview: preview, verdict: 'unknown' }
  const hist = previewHistogram(preview.path)
  if (!hist) return { similarity: null, lumaSimilarity: null, preview: preview, verdict: 'unknown' }
  const sim = histogramSimilarity(hist.bins, chosen.bins)
  const luma = chosen.luma ? lumaSimilarity(hist.luma, chosen.luma) : null
  const worst = luma == null ? sim : Math.min(sim, luma)
  return {
    similarity: Math.round(sim * 1000) / 1000,
    lumaSimilarity: luma == null ? null : Math.round(luma * 1000) / 1000,
    preview: preview,
    previewSize: hist.width + 'x' + hist.height,
    verdict: worst < 0.45 ? 'mismatch' : 'ok',
  }
}
