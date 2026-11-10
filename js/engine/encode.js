// Base32, URL and quoted printable encodings.

export const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function bytesToB32(u8){
  let out = "", bits = 0, acc = 0;
  for (const b of u8){
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5){ out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
}

export function bytesToUrlEnc(u8){
  const safe = /[A-Za-z0-9\-_.~]/;
  let out = "";
  for (const b of u8){
    const c = String.fromCharCode(b);
    out += safe.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function bytesToQp(u8){
  const hex = b => "=" + b.toString(16).toUpperCase().padStart(2, "0");
  let line = "", out = [];
  const flush = soft => { out.push(soft ? line + "=" : line); line = ""; };
  for (let i = 0; i < u8.length; i++){
    const b = u8[i];
    if (b === 10){ out.push(line.replace(/[ \t]+$/, m => m.split("").map(c => hex(c.charCodeAt(0))).join(""))); line = ""; continue; }
    if (b === 13) continue;
    const tok = (b === 61 || b < 32 || b > 126) ? hex(b) : String.fromCharCode(b);
    if (line.length + tok.length > 75) flush(true);
    line += tok;
  }
  if (line) flush(false);
  return out.join("\r\n") + "\r\n";
}
