// 假的 OneBot 服务端：验证 bridge → dsh(ACP) → 回复 的完整链路，不依赖 NapCat。
import http from 'node:http';
import { WebSocketServer } from 'ws';

const HTTP_PORT = 3100;
const WS_PORT = 3101;
const SELF_ID = 10000;
const USER_ID = 20001;

const received = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const action = (req.url ?? '/').replace(/^\//, '');
    console.log(`[mock] ${action} ${body}`);
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      received.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 900 + received.length } }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
  });
});

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (socket) => {
  console.log('[mock] ws connected');
  setTimeout(() => {
    socket.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        time: Math.floor(Date.now() / 1000),
        self_id: SELF_ID,
        user_id: USER_ID,
        message_id: 5555,
        raw_message: '在吗？用一句话介绍下你自己',
        message: [{ type: 'text', data: { text: '在吗？用一句话介绍下你自己' } }],
        sender: { user_id: USER_ID, nickname: '测试网友' },
      }),
    );
    console.log('[mock] event sent');
  }, 1500);
});

server.listen(HTTP_PORT, () => console.log(`[mock] http on ${HTTP_PORT}, ws on ${WS_PORT}`));

const deadline = setTimeout(() => {
  console.log(`[mock] TIMEOUT, replies=${JSON.stringify(received)}`);
  process.exit(2);
}, 180_000);

const poll = setInterval(() => {
  if (received.length > 0) {
    const text = received.map((item) => String(item.message)).join('\n---\n');
    console.log('[mock] REPLY:\n' + text);
    if (text.trim().length > 0) {
      clearTimeout(deadline);
      clearInterval(poll);
      setTimeout(() => process.exit(0), 500);
    }
  }
}, 500);
