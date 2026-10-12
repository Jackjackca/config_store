/**
 * bili-ai-comment-summary.js
 * Loon 脚本：调用 AI 总结 B 站视频评论区，并把总结作为"第一条评论"插入评论列表。
 *
 * 目标接口（来自 iOS 客户端 9.13.0 抓包）：
 *   POST https://grpc.biliapi.net/bilibili.main.community.reply.v1.Reply/MainList
 *   响应为 gRPC 帧：[1字节压缩flag][4字节大端长度][protobuf(MainListReply)]，flag=1 时消息体为 gzip。
 *   MainListReply 结构（按抓包逆向）：
 *     字段2  = repeated Reply   主评论列表（本脚本在最前面插入一条伪造评论）
 *     字段3  = 评论区主体信息（仅第一页有，用于判断"第一页"）
 *     字段4/14 = Reply          置顶评论（不改动）
 *   Reply 结构：
 *     字段1  = repeated Reply   楼中楼预览
 *     字段2  = rpid  字段3 = oid  字段4 = type  字段5 = mid
 *     字段9  = 点赞数  字段10 = ctime  字段11 = 回复数
 *     字段12 = Content { 1: 评论文本 }
 *     字段13 = Member  { 1: mid, 2: 用户名, 3: 性别, 4: 头像 }
 *     字段14 = ReplyControl { 23: 发布时间文本 }
 *
 * ──────────────── Loon 接入方法 ────────────────
 * 1. 要求 Loon Build ≥ 988（需要 $utils.gzip / $utils.ungzip 处理 gRPC 帧压缩）。
 * 2. 把本脚本保存为本地脚本（或托管到 HTTPS 脚本地址），配置规则：
 *
 *    [Script]
 *    http-response ^https:\/\/grpc\.biliapi\.net\/bilibili\.main\.community\.reply\.v1\.Reply\/MainList \
 *      script-path=bili-ai-comment-summary.js, \
 *      tag=B站评论AI总结, \
 *      requires-body=true, \
 *      binary-body-mode=true, \
 *      timeout=60, \
 *      argument="aiBaseUrl=https://api.deepseek.com/v1&aiApiKey=sk-XXXX&aiModel=deepseek-chat", \
 *      enable=true
 *
 *    [MITM]
 *    hostname = grpc.biliapi.net
 *
 *    ⚠ 必须开启 binary-body-mode=true，否则拿不到二进制 protobuf（会直接透传不生效）。
 *    ⚠ timeout 建议 60（AI 首次生成需要数秒），AI 请求自身超时可通过 aiTimeout 配置。
 *
 * 3. argument 为 key=value&key=value 形式；写在插件(.plugin)里时 $argument 是对象，两种都支持。
 *    可配置项（括号内为默认值）：
 *      aiBaseUrl   (https://api.openai.com/v1)  OpenAI 兼容接口地址
 *      aiApiKey    (必填)                       API Key
 *      aiModel     (gpt-4o-mini)                模型名
 *      aiSystem    (内置中文总结提示词)          自定义 system 提示词（需 URL 编码）
 *      maxComments (30)                         参与总结的评论条数上限
 *      maxChars    (6000)                       参与总结的文本总字数上限
 *      cacheTtl    (12)                         总结缓存小时数（同一视频重复打开秒出）
 *      aiTimeout   (30000)                      AI 请求超时毫秒
 *      uname       (AI·评论区总结)               伪造评论的用户名
 *      avatar      (B站AI图标)                   伪造评论的头像 URL
 *      prefix      (【AI 评论区总结】)            伪造评论正文前缀
 *      timeText    (AI 生成 · 刚刚)              伪造评论的时间文本
 *      injectMode  (first)                      first=只在第一页注入；all=每页都注入
 *      notifyError (false)                      AI 失败时是否弹通知
 */

// ============================== 配置 ==============================

var DEFAULTS = {
  aiBaseUrl: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiSystem: "你是B站评论区观察员。用户会给你一个视频的热门评论列表，" +
    "请用简体中文总结评论区的主要观点、争议点和整体氛围，" +
    "输出3~5条要点，每条不超过30字，不要加开场白，直接输出要点。",
  maxComments: "30",
  maxChars: "6000",
  cacheTtl: "12",
  aiTimeout: "30000",
  uname: "AI·评论区总结",
  avatar: "https://i0.hdslb.com/bfs/app/f345a14b57fa6eb879466ec361d217f9ddc24354.png",
  prefix: "【AI 评论区总结】",
  timeText: "AI 生成 · 刚刚",
  injectMode: "first",
  notifyError: "false"
};

function parseArgument(arg) {
  var out = {};
  if (!arg) return out;
  if (typeof arg === "object") {
    // 插件参数：对象形式
    for (var k in arg) {
      if (Object.prototype.hasOwnProperty.call(arg, k)) out[k] = String(arg[k]);
    }
    return out;
  }
  // 普通 Script 规则参数："a=1&b=2"
  var pairs = String(arg).split("&");
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var eq = pairs[i].indexOf("=");
    if (eq <= 0) continue;
    var key = pairs[i].slice(0, eq);
    var val = pairs[i].slice(eq + 1);
    try { val = decodeURIComponent(val); } catch (e) {}
    out[key] = val;
  }
  return out;
}

var ARG = parseArgument(typeof $argument === "undefined" ? null : $argument);
var CFG = {};
for (var ck in DEFAULTS) {
  if (Object.prototype.hasOwnProperty.call(DEFAULTS, ck)) {
    CFG[ck] = ARG[ck] !== undefined && ARG[ck] !== "" ? ARG[ck] : DEFAULTS[ck];
  }
}
for (var ek in ARG) {
  if (!Object.prototype.hasOwnProperty.call(CFG, ek)) CFG[ek] = ARG[ek];
}
CFG.maxComments = parseInt(CFG.maxComments, 10) || 30;
CFG.maxChars = parseInt(CFG.maxChars, 10) || 6000;
CFG.cacheTtl = (parseFloat(CFG.cacheTtl) || 12) * 3600 * 1000;
CFG.aiTimeout = parseInt(CFG.aiTimeout, 10) || 30000;

// ============================== 基础工具 ==============================

function log() {
  if (typeof console !== "undefined" && console.log) console.log.apply ? console.log.apply(console, arguments) : console.log(arguments[0]);
}

function utf8Encode(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes, start, end) {
  start = start || 0;
  end = end === undefined ? bytes.length : end;
  var out = "";
  var i = start;
  while (i < end) {
    var b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function concatBytes(arrays) {
  var total = 0, i;
  for (i = 0; i < arrays.length; i++) total += arrays[i].length;
  var out = new Uint8Array(total);
  var pos = 0;
  for (i = 0; i < arrays.length; i++) {
    out.set(arrays[i], pos);
    pos += arrays[i].length;
  }
  return out;
}

// ============================== protobuf 读写 ==============================

// 解码 varint 为 Number（仅用于 oid/ctime 等安全范围内的字段，超范围只做跳过不回写）
function readVarint(bytes, pos) {
  var value = 0, mul = 1, p = pos;
  while (p < bytes.length) {
    var b = bytes[p++];
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) break;
    mul *= 128;
  }
  return { value: value, next: p };
}

function encodeVarint(n) {
  var out = [];
  n = Math.floor(n);
  do {
    var b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return new Uint8Array(out);
}

function encodeKey(fieldNo, wire) {
  return encodeVarint(fieldNo * 8 + wire);
}

function encodeVarintField(fieldNo, n) {
  return concatBytes([encodeKey(fieldNo, 0), encodeVarint(n)]);
}

function encodeBytesField(fieldNo, bytes) {
  return concatBytes([encodeKey(fieldNo, 2), encodeVarint(bytes.length), bytes]);
}

function encodeStringField(fieldNo, str) {
  return encodeBytesField(fieldNo, utf8Encode(str));
}

// 按"原始字节切片"解析消息字段，重建时原样拼回，保证未知字段不丢失
function parseFields(bytes) {
  var fields = [];
  var pos = 0;
  while (pos < bytes.length) {
    var keyStart = pos;
    var k = readVarint(bytes, pos);
    pos = k.next;
    var fieldNo = Math.floor(k.value / 8);
    var wire = k.value % 8;
    if (fieldNo === 0) throw new Error("bad field number");
    var value = null, vStart = pos;
    if (wire === 0) {
      var v = readVarint(bytes, pos);
      value = v.value;
      pos = v.next;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 2) {
      var l = readVarint(bytes, pos);
      pos = l.next;
      vStart = pos;
      pos += l.value;
      if (pos > bytes.length) throw new Error("bad length");
    } else if (wire === 5) {
      pos += 4;
    } else {
      throw new Error("bad wire type " + wire);
    }
    fields.push({
      no: fieldNo,
      wire: wire,
      keyStart: keyStart,
      vStart: vStart,
      vEnd: pos,
      raw: bytes.subarray(keyStart, pos),
      value: value
    });
  }
  return fields;
}

function findField(fields, no) {
  for (var i = 0; i < fields.length; i++) if (fields[i].no === no) return fields[i];
  return null;
}

// ============================== gRPC 帧 ==============================

// 返回 [{flag, msg:Uint8Array}]，格式不合法时抛错（调用方回退透传）
function splitGrpcFrames(bytes) {
  var frames = [];
  var pos = 0;
  while (pos < bytes.length) {
    if (pos + 5 > bytes.length) throw new Error("truncated grpc frame header");
    var flag = bytes[pos];
    var len = ((bytes[pos + 1] << 24) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 8) | bytes[pos + 4]) >>> 0;
    pos += 5;
    if (pos + len > bytes.length) throw new Error("truncated grpc frame body");
    frames.push({ flag: flag, msg: bytes.subarray(pos, pos + len) });
    pos += len;
  }
  return frames;
}

function buildGrpcFrame(flag, msg) {
  var header = new Uint8Array(5);
  header[0] = flag;
  var len = msg.length;
  header[1] = (len >>> 24) & 0xff;
  header[2] = (len >>> 16) & 0xff;
  header[3] = (len >>> 8) & 0xff;
  header[4] = len & 0xff;
  return concatBytes([header, msg]);
}

function frameMessage(frame) {
  // flag=1 表示消息体为 gzip（grpc-encoding: gzip）
  if (frame.flag === 1) return gunzipBytes(frame.msg);
  return frame.msg;
}

function gzipBytes(bytes) {
  return $utils.gzip(bytes);
}

function gunzipBytes(bytes) {
  return $utils.ungzip(bytes);
}

// ============================== 评论区业务 ==============================

// Reply.content(12).message(1)
function replyText(replyBytes) {
  var f = parseFields(replyBytes);
  var content = findField(f, 12);
  if (!content) return "";
  var contentBytes = replyBytes.subarray(content.vStart, content.vEnd);
  var cf = parseFields(contentBytes);
  var msg = findField(cf, 1);
  if (!msg) return "";
  return utf8Decode(contentBytes, msg.vStart, msg.vEnd).trim();
}

// Reply.member(13) 里的用户名(2)
function replyMemberName(replyBytes) {
  var f = parseFields(replyBytes);
  var member = findField(f, 13);
  if (!member) return "";
  var memberBytes = replyBytes.subarray(member.vStart, member.vEnd);
  var mf = parseFields(memberBytes);
  var uname = findField(mf, 2);
  if (!uname) return "";
  return utf8Decode(memberBytes, uname.vStart, uname.vEnd).trim();
}

// 从 MainListReply 提取评论文本（主评论 + 楼中楼预览 + 置顶评论）
function extractComments(msgBytes) {
  var top = parseFields(msgBytes);
  var out = [];
  for (var i = 0; i < top.length; i++) {
    var f = top[i];
    // 2=主评论列表  4/14=置顶评论
    if (f.wire !== 2 || (f.no !== 2 && f.no !== 4 && f.no !== 14)) continue;
    var replyBytes = msgBytes.subarray(f.vStart, f.vEnd);
    var text = replyText(replyBytes);
    var name = replyMemberName(replyBytes);
    if (text) out.push((name ? name + "：" : "") + text);
    // 楼中楼预览：Reply.1 = repeated Reply
    try {
      var rf = parseFields(replyBytes);
      for (var j = 0; j < rf.length; j++) {
        if (rf[j].no !== 1 || rf[j].wire !== 2) continue;
        var childBytes = replyBytes.subarray(rf[j].vStart, rf[j].vEnd);
        var childText = replyText(childBytes);
        if (childText) out.push("  └ " + childText);
      }
    } catch (e) {}
  }
  return out;
}

// 参与总结的文本（受条数/字数限制）
function buildSummaryInput(comments) {
  var picked = [];
  var total = 0;
  for (var i = 0; i < comments.length && picked.length < CFG.maxComments; i++) {
    if (total + comments[i].length > CFG.maxChars) break;
    picked.push(comments[i]);
    total += comments[i].length;
  }
  return picked;
}

// 构造一条伪造的 Reply
function buildFakeReply(oid, summaryText) {
  var content = encodeStringField(1, summaryText);
  var member = concatBytes([
    encodeStringField(2, CFG.uname),
    encodeStringField(3, "保密"),
    encodeStringField(4, CFG.avatar)
  ]);
  var control = encodeStringField(23, CFG.timeText);
  var rpid = 8000000000000000 + (Date.now() % 100000000);
  return concatBytes([
    encodeVarintField(2, rpid),   // rpid
    encodeVarintField(3, oid),    // oid：与评论区一致
    encodeVarintField(4, 1),      // type=1 视频评论区
    encodeVarintField(5, 0),      // mid=0
    encodeVarintField(10, Math.floor(Date.now() / 1000)), // ctime
    encodeBytesField(12, content),
    encodeBytesField(13, member),
    encodeBytesField(14, control)
  ]);
}

// 在 MainListReply 的第一个字段2（主评论）前插入伪造评论
function injectFakeReply(msgBytes, fakeReply) {
  var top = parseFields(msgBytes);
  var parts = [];
  var inserted = false;
  for (var i = 0; i < top.length; i++) {
    if (!inserted && top[i].no === 2) {
      parts.push(encodeBytesField(2, fakeReply));
      inserted = true;
    }
    parts.push(top[i].raw);
  }
  if (!inserted) throw new Error("no reply field found");
  return concatBytes(parts);
}

// ============================== AI 调用与缓存 ==============================

function cacheKey(oid) {
  return "bili-ai-summary:" + oid;
}

function readCache(oid) {
  try {
    var raw = $persistentStore.read(cacheKey(oid));
    if (!raw) return null;
    var obj = JSON.parse(raw);
    if (!obj || !obj.text) return null;
    if (Date.now() - obj.ts > CFG.cacheTtl) return null;
    return obj.text;
  } catch (e) {
    return null;
  }
}

function writeCache(oid, text) {
  try {
    $persistentStore.write(JSON.stringify({ ts: Date.now(), text: text }), cacheKey(oid));
  } catch (e) {}
}

function callAI(comments, callback) {
  var userContent =
    "以下是某B站视频评论区的热门评论（每行一条，缩进为楼中楼回复）：\n\n" +
    comments.join("\n") +
    "\n\n请按你的规则总结这个评论区。";
  var payload = {
    model: CFG.aiModel,
    messages: [
      { role: "system", content: CFG.aiSystem },
      { role: "user", content: userContent }
    ],
    temperature: 0.6
  };
  $httpClient.post(
    {
      url: CFG.aiBaseUrl.replace(/\/+$/, "") + "/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + CFG.aiApiKey
      },
      body: JSON.stringify(payload),
      timeout: CFG.aiTimeout
    },
    function (err, resp, data) {
      if (err) return callback(new Error("AI request failed: " + err));
      try {
        var status = resp && resp.status;
        var body = typeof data === "string" ? JSON.parse(data) : JSON.parse(utf8Decode(data));
        if (status && status >= 400) {
          return callback(new Error("AI http " + status + ": " + String(data).slice(0, 200)));
        }
        var content = body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
        if (!content) return callback(new Error("AI response missing content: " + String(data).slice(0, 200)));
        callback(null, String(content).trim());
      } catch (e) {
        callback(new Error("AI response parse error: " + e.message));
      }
    }
  );
}

function notifyError(msg) {
  if (String(CFG.notifyError).toLowerCase() === "true" && typeof $notification !== "undefined") {
    $notification.post("B站评论AI总结", "生成失败", msg);
  }
}

// ============================== 主流程 ==============================

function passThrough() {
  $done({});
}

function main() {
  var body = $response && $response.body;
  if (!body || !(body instanceof Uint8Array)) {
    log("[bili-ai] body 不是 Uint8Array，请确认规则开启了 requires-body=true 且 binary-body-mode=true");
    passThrough();
    return;
  }

  var frames;
  try {
    frames = splitGrpcFrames(body);
    if (!frames.length) throw new Error("empty");
  } catch (e) {
    log("[bili-ai] body 不是 gRPC 帧，透传：" + e.message);
    passThrough();
    return;
  }

  var msgBytes, usedFrameIdx = -1;
  for (var i = 0; i < frames.length; i++) {
    try {
      var candidate = frameMessage(frames[i]);
      var top = parseFields(candidate);
      if (findField(top, 2)) { msgBytes = candidate; usedFrameIdx = i; break; }
    } catch (e) {}
  }
  if (usedFrameIdx < 0) {
    log("[bili-ai] 未找到评论列表消息，透传");
    passThrough();
    return;
  }

  var topFields = parseFields(msgBytes);

  // 只在第一页注入：第一页响应带字段3（评论区主体信息）
  if (CFG.injectMode === "first" && !findField(topFields, 3)) {
    log("[bili-ai] 非第一页评论响应，透传");
    passThrough();
    return;
  }

  // oid 取自第一条主评论的字段3（与视频 aid 一致）
  var oid = 0;
  for (var j = 0; j < topFields.length; j++) {
    if (topFields[j].no === 2 && topFields[j].wire === 2) {
      try {
        var rf = parseFields(msgBytes.subarray(topFields[j].vStart, topFields[j].vEnd));
        var oidField = findField(rf, 3);
        if (oidField) { oid = oidField.value; break; }
      } catch (e) {}
    }
  }

  var comments = extractComments(msgBytes);
  if (!comments.length) {
    log("[bili-ai] 评论为空，透传");
    passThrough();
    return;
  }

  function finish(summary) {
    try {
      var fakeReply = buildFakeReply(oid, CFG.prefix ? CFG.prefix + "\n" + summary : summary);
      var newMsg = injectFakeReply(msgBytes, fakeReply);
      var outFrames = [];
      for (var i = 0; i < frames.length; i++) {
        if (i === usedFrameIdx) {
          if (frames[i].flag === 1) {
            outFrames.push(buildGrpcFrame(1, gzipBytes(newMsg)));
          } else {
            outFrames.push(buildGrpcFrame(0, newMsg));
          }
        } else {
          outFrames.push(buildGrpcFrame(frames[i].flag, frames[i].msg));
        }
      }
      $done({ body: concatBytes(outFrames) });
    } catch (e) {
      log("[bili-ai] 注入失败：" + e.message);
      notifyError("注入失败：" + e.message);
      passThrough();
    }
  }

  var cached = oid ? readCache(oid) : null;
  if (cached) {
    log("[bili-ai] 命中缓存 oid=" + oid);
    finish(cached);
    return;
  }

  log("[bili-ai] 调用 AI 总结 " + comments.length + " 条评论，oid=" + oid);
  callAI(buildSummaryInput(comments), function (err, summary) {
    if (err || !summary) {
      log("[bili-ai] AI 失败：" + (err ? err.message : "空结果"));
      notifyError(err ? err.message : "空结果");
      passThrough();
      return;
    }
    if (oid) writeCache(oid, summary);
    finish(summary);
  });
}

main();
