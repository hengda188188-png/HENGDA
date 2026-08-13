/**
 * 區網 IP 偵測。多網卡/VPN 會有多個候選，全部列出讓使用者切換（邊界情境：Tailscale 會插隊）。
 */
import os from 'node:os';

const PRIVATE_RANGES = [
  { test: (p) => p[0] === 192 && p[1] === 168, label: '家用/辦公室 Wi-Fi', score: 100 },
  { test: (p) => p[0] === 10, label: '內部網路', score: 80 },
  { test: (p) => p[0] === 172 && p[1] >= 16 && p[1] <= 31, label: '內部網路', score: 70 },
  { test: (p) => p[0] === 100 && p[1] >= 64 && p[1] <= 127, label: 'Tailscale/CGNAT（手機需也在同一 VPN）', score: 20 },
  { test: (p) => p[0] === 169 && p[1] === 254, label: '未取得 IP（連線異常）', score: 1 },
];

/**
 * @returns {{address:string, iface:string, label:string, score:number}[]} 依可用性排序，最推薦的在最前
 */
export function listLanAddresses() {
  const found = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const parts = addr.address.split('.').map(Number);
      const range = PRIVATE_RANGES.find((r) => r.test(parts));
      if (!range) continue;
      let score = range.score;
      // 虛擬網卡/VPN 常常也長得像區網 IP，但手機連不到 → 一律往後排（實測：VPN 網卡曾被排到第一）
      if (/vEthernet|Virtual|VMware|VirtualBox|Loopback|Hyper-V|Docker|WSL/i.test(iface)) score -= 40;
      if (/VPN|Tailscale|ZeroTier|Hamachi|OpenVPN|WireGuard|TAP-|TUN/i.test(iface)) score -= 60;
      if (/Wi-?Fi|WLAN|無線|Wireless/i.test(iface)) score += 8;
      if (/Ethernet|乙太|有線/i.test(iface)) score += 5;
      found.push({ address: addr.address, iface, label: range.label, score });
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

/** 組出手機要開的網址 */
export function mobileUrl(address, port, token) {
  return `http://${address}:${port}/m/${token}`;
}
