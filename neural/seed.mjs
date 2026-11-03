// 种子数据：用于开发与演示。真实数据由 MiMo 通过 MCP 上报。
// 用法：node seed.mjs [--reset]
const API = process.env.NEURAL_API || 'http://127.0.0.1:3002/neural-api';
const TOKEN = process.env.NEURAL_TOKEN || '';

const TOPICS = [
  {
    session: 'chaoxing-dev',
    tags: ['超星', '答题', 'Python'],
    items: [
      ['题库解析器重构', '把本地题库的解析层拆成独立的模块，支持多格式导入。'],
      ['AI 答题准确率调优', '针对多选题的边界情况补了规则，准确率从 78% 提到 91%。'],
      ['考试模式 Beta 的异常兜底', '考试作答加了超时重试和中断恢复，避免中途掉线。'],
      ['自动播放的节奏控制', '章节切换太快会被判定异常，加入随机停留时间。'],
      ['共享题库的同步策略', '变成增量拉取，只同步新增和修改过的条目。'],
      ['桌面客户端打包', '用 PyInstaller 打单文件，体积压到 28MB。'],
      ['程序内更新通道', '实现了版本比对和静默下载，重启后自动替换。'],
      ['卸载时保留资料的选项', '用户可以选择卸载时是否保留本地题库和配置。'],
      ['登录态维护', '处理 cookie 过期后的静默续期。'],
      ['日志脱敏', '把日志里的学号和姓名做了掩码处理。'],
    ],
  },
  {
    session: 'aurora-audio',
    tags: ['音频', 'Dolby', 'Android'],
    items: [
      ['双扬声器调音的基线采样', '先导出原厂 XML，确认识别到的 Profile ID。'],
      ['影院包围预设的听感调整', '低频下潜多留了一点，人声做了轻微前移。'],
      ['外接路线保护逻辑', '只改 speaker endpoint，耳机和蓝牙走原厂节点。'],
      ['属性回读的状态机', '区分 XML_BOUND、ACTIVE、STOCK、DEGRADED 四种状态。'],
      ['安全模式与卸载恢复', '应用前快照，卸载时写回原值。'],
      ['WebUI 的十段 EQ', '中文移动端分组界面，滑块的触控区域加大。'],
      ['低频上限的修复', '某些机型上 boost 会削波，加了限幅。'],
      ['v5.7.0 的回归测试', '三台设备上验证预设全部可切换。'],
    ],
  },
  {
    session: 'brightness',
    tags: ['亮度', 'MIUI', 'Xposed'],
    items: [
      ['自动亮度的曲线建模', '把小米的对数曲线映射成更接近 iOS 的观感。'],
      ['环境光传感器的采样平滑', '去掉突变，避免亮度跳变。'],
      ['夜间模式的温度联动', '色温随亮度一起调，不只是降蓝光。'],
      ['AOD 状态下的调度', '息屏显示时降低采样频率省电。'],
    ],
  },
  {
    session: 'agent-study',
    tags: ['Agent', '学习', '协作'],
    items: [
      ['把提问改写成可验证的问题', '先定目标和完成标准，再交给模型。'],
      ['上下文准备的最小集', '只给必要背景，避免信息过载反而失焦。'],
      ['分步执行与中间验证', '每一步产出可检查的结果，不追求一次成型。'],
      ['结果复盘模板', '记录失败原因，形成可复用的提示模式。'],
      ['工具调用边界的观察', '什么样的任务适合交给 agent，什么必须自己做。'],
      ['长任务的状态保持', '用文件记录进度，避免上下文丢失后重来。'],
    ],
  },
  {
    session: 'server-ops',
    tags: ['服务器', '部署', 'Nginx'],
    items: [
      ['从 GitHub Pages 迁到自有服务器', '香港机器免备案，nginx 直接托管静态产物。'],
      ['443 端口的协议分流', 'TLS 走 8443，SSH 走 22，共用一个入口。'],
      ['链路间歇性阻断的排查', 'ping 通但端口断，最后定位到代理的 TUN 模式。'],
      ['ufw 与安全组的两层放行', '漏了 ufw 导致所有外部访问超时。'],
      ['后台服务的 systemd 化', '写完内容本地构建，几秒钟上线。'],
      ['证书自动续期', 'certbot 定时任务，90 天周期。'],
      ['图片缓存的坑', '文件名不变时 30 天 immutable 缓存不会失效。'],
    ],
  },
  {
    session: 'blog-design',
    tags: ['设计', '博客', '排版'],
    items: [
      ['标题字号的上限', 'clamp 没有上限导致宽屏折行，把孤字问题压下去。'],
      ['间距收敛到 8pt 网格', '原本 15/17/25 这类随手值统一掉。'],
      ['辅助文字的对比度', '9px 的标签提到 11px，灰阶加深到符合 AA。'],
      ['深色与浅色的两套语言', '同一个组件在两种模式下都要成立。'],
      ['头像的裁剪与圆形', '不规则圆形配照片像设计，配图标像错位。'],
    ],
  },
  {
    session: 'research',
    tags: ['安全', '学习', '网络'],
    items: [
      ['TCP 三次握手与阻断识别', '区分拒绝、超时、重置三种表现的成因。'],
      ['TLS 证书链的验证路径', '从根证书到中间证书再到服务端。'],
      ['DNS 解析的缓存层级', '浏览器、系统、递归服务器各自缓存多久。'],
      ['HTTP 缓存头的作用域', 'immutable 与 max-age 的组合效果。'],
    ],
  },
];

function pick(arr, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(arr[Math.floor(Math.random() * arr.length)]);
  return out;
}

function jitterDate(startDaysAgo, endDaysAgo) {
  const now = Date.now();
  const from = now - startDaysAgo * 86400000;
  const to = now - endDaysAgo * 86400000;
  return new Date(from + Math.random() * (to - from)).toISOString();
}

async function main() {
  const reset = process.argv.includes('--reset');
  if (reset) {
    console.log('（重置由服务端数据库文件控制，这里只追加）');
  }

  const flat = [];
  for (const topic of TOPICS) {
    for (const [title, summary] of topic.items) {
      // 每个主题的节点散布在最近 90 天内
      flat.push({
        title,
        summary,
        tags: pick(topic.tags, 1 + Math.floor(Math.random() * topic.tags.length)),
        sessionId: topic.session,
        kind: Math.random() < 0.15 ? 'insight' : 'dialog',
        weight: 0.8 + Math.random() * 1.4,
        createdAt: jitterDate(400, 0),
      });
    }
  }

  flat.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  let ok = 0;
  for (const item of flat) {
    const res = await fetch(`${API}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(item),
    });
    if (res.ok) ok += 1;
    else console.error('失败:', item.title, await res.text());
  }

  const stats = await fetch(`${API}/stats`).then((r) => r.json());
  console.log(`写入 ${ok} 条，当前总数 ${stats.total}，突触 ${stats.edges}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});