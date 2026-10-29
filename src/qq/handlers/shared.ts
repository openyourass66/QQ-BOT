export function parseShanghaiTime(text: string): number {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text))
        throw new Error('时间格式应为 YYYY-MM-DD HH:mm（上海时间）');
    const value = Date.parse(text.replace(' ', 'T') + ':00+08:00');
    if (!Number.isFinite(value) || new Date(value + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') !== text)
        throw new Error('日期或时间无效');
    return value;
}
export function toFile(file: string): string { return new URL('file:///' + file.replace(/\\/g, '/').replace(/^\//, '').split('/').map((p, i) => i === 0 && p.endsWith(':') ? p : encodeURIComponent(p)).join('/')).href; }
