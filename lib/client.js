/**
 * dsh-chain-shared 客户端半：会话视图里的「思维链」tab（v12 真 3D 星云）。
 *
 * 手写、不走构建，必须守住宿主模块加载器的格式（`window.__ModuleLoader__.load`），
 * 不能用 JSX；组件一律 React.createElement，CSS 用带 data-plugin 标记的 <style> 注入。
 *
 * ── v12 修的是什么（2026-10-28 用户一句话点破）────────────────────
 *   「你的节点根本没动态，是一张 2d 的纸在 3d 旋转」
 *
 *   v11 的错：布局把坐标烤死成静态 cx/cy，再给整组套 CSS rotate。
 *   点没有深度 → 旋转时不会近大远小、不会改变亮度、没有视差 = 平面纸片。
 *
 *   v12：每个点存 (x, y, z)，**每帧绕 Y / 绕 X 旋转后重新透视投影**：
 *     k = focal / (focal + z')；屏幕坐标 ×k、半径 ×k、亮度按 k 衰减。
 *     直接写 DOM 属性，React 一次都不重渲染。
 *
 * ── 性能取舍（别改回去）──────────────────────────────────────────
 *   · 上限 30fps（慢速自转不需要 60）
 *   · 依据微粒每 3 帧更新一次（最小、肉眼无感）
 *   · 全程零 SVG filter，光晕一律叠圆 / 径向渐变
 *   · 进/出聚焦态只动两个元素
 */

window.__ModuleLoader__.load({
  id: 'dsh-chain-shared',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    /* ════════════ 池定义（颜色是用户一条条点的，别自己调） ════════════ */

    var POOL_SPEC = [
      { key: 'core', label: '核心', color: '#ffd24a' },
      { key: 'fact', label: '事实', color: '#b9a6ff' },
      // **技能拆成两颗**（2026-10-30 用户 定）：铁律与经验不是同一种东西 ——
      // 铁律是"失约过的才知道"，漏一条就是失信，永远在那儿；经验是"用得上才翻"。
      // 颜色：**铁律用红色**（用户 2026-10-30 亲自指定 —— 红线就该是红的），经验沿用绿色。
      { key: 'skillRule', label: '铁律', color: '#ff4d4f' },
      { key: 'skillExp', label: '经验', color: '#59d98e' },
      { key: 'dailyCore', label: '核心日常', color: '#2f6bff' },
      { key: 'dailyPartial', label: '片面日常', color: '#7fd4ff' },
      // **情绪改白粉**（2026-10-30 用户定）：它是"感知区"那一团，白粉最像心情。
      { key: 'emotion', label: '情绪·感知区', color: '#ffd6e7' },
      // 两个**虚拟区**：没有对应记忆池，只是给"联想 → 提炼"这条动线一个落点。
      // 颜色是用户点的：决策紫、元记忆橙。
      { key: 'decision', label: '决策区', color: '#b06bff', virtual: true },
      { key: 'meta', label: '元记忆', color: '#ffa64d', virtual: true },
      { key: 'hippocampus', label: '海马体', color: '#f2f7ff' },
    ];
    var POOL_MAP = {};
    for (var pi = 0; pi < POOL_SPEC.length; pi += 1) POOL_MAP[POOL_SPEC[pi].key] = POOL_SPEC[pi];

    // **三个区的锚点**（2026-10-30 用户定的分区）：感知区在左（白粉）、决策区右后（紫）、
    // 元记忆区右前（橙）。写死坐标，一眼能分出三块 —— 跟着随机环走就分不出来了。
    // **四个功能区统一半径 0.55 等角分布**（2026-10-30 第三次收）：
    // 之前散在 0.5–0.7 各处，加上卫星壳整体就"散"了。
    // 现在四个区围成一个规整的圈，中间是球 + 卫星环 —— 一眼能看出"球 + 四个站"。
    // **球的半径**（2026-10-30）：布局和渲染两处都要用，必须放模块作用域。
    // 之前它声明在 computeLayout 里面，而 projectFrame 也引用它 ->
    // 渲染时 ReferenceError -> 整个画布组件崩掉 -> 思维链进不去。
    // 这类错 node --check 查不出来，只有真正渲染才知道。
    var SPHERE_R = 0.40;
    // 布局最后会把所有坐标按 span 除一遍（归一化），所以**画边缘光时也要用除过之后的半径** ——
    // 否则点云在 0.67、光圈画在 0.40，看着就不像一个球（2026-10-30 截图实证）。
    var SPHERE_R_DRAW = 0.40;

    // **功能区名单**（2026-10-30）：这四个区不参与球面归环，各钉各的锚点。
    // ⚠️ 之前这行在布局函数里，改布局时被删掉了 —— 只剩使用、没有声明 ->
    // 布局一跑就 ReferenceError -> 画布起不来 -> 思维链进不去。**同一个病今天犯了两次。**
    var ZONE_KEYS = { emotion: 1, decision: 1, meta: 1, hippocampus: 1 };

    var ZONES = {
      sense: { x: -0.54, y: 0.10, z: 0.14 },
      decide: { x: 0.52, y: -0.19, z: 0.06 },
      meta: { x: 0.52, y: 0.19, z: -0.06 },
      hippo: { x: -0.19, y: -0.52, z: -0.14 },
    };

    var VERSION = 'v2.4.1';
    var FOCAL = 2.4;

    /* ════════════ 样式 ════════════ */

    var CSS = [
      '.chg-root{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;',
      'background:radial-gradient(ellipse at 50% 46%,#070b14 0%,#04060a 55%,#020307 100%);',
      'color:var(--dsw-alias-label-primary,#e6edf7);font-size:12px;}',
      '.chg-bar{display:flex;align-items:center;gap:8px;flex:none;padding:7px 10px;',
      'border-bottom:1px solid rgba(120,150,200,.08);font-size:11px;letter-spacing:.2px;}',
      '.chg-k{color:rgba(190,205,230,.55);}',
      '.chg-btn{border:1px solid rgba(140,175,225,.22);background:rgba(24,34,52,.5);',
      'color:rgba(205,218,240,.82);border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;}',
      '.chg-btn[data-on="1"]{background:rgba(90,140,220,.26);border-color:rgba(150,190,255,.5);color:#eaf2ff;}',
      '.chg-stage{position:relative;flex:1;min-height:0;}',
      '.chg-legend{position:absolute;left:12px;bottom:125px;width:174px;max-width:calc(100% - 24px);',
      'max-height:calc(100% - 24px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;',
      'background:linear-gradient(145deg,rgba(19,27,42,.86),rgba(7,12,22,.78));backdrop-filter:blur(14px);',
      'border:1px solid rgba(160,185,220,.17);border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.28);',
      'color:rgba(226,235,249,.92);font-size:11px;}',
      '.chg-legend[data-collapsed="1"]{width:auto;border-radius:11px;}',
      '.chg-legend button{font:inherit;color:inherit;cursor:pointer;}',
      '.chg-legend-head{display:flex;align-items:center;gap:8px;flex:none;width:100%;padding:10px 12px;',
      'border:0;background:transparent;text-align:left;}',
      '.chg-legend-head strong{font-size:11px;font-weight:600;letter-spacing:1px;}',
      '.chg-legend-meta{margin-left:auto;color:rgba(185,202,226,.55);font-size:10px;white-space:nowrap;}',
      '.chg-legend-chevron{color:rgba(185,202,226,.65);font-size:12px;}',
      '.chg-legend-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 6px 6px;',
      'scrollbar-width:thin;scrollbar-color:rgba(160,185,220,.25) transparent;}',
      '.chg-legend-hint{margin:0 6px 7px;color:rgba(185,202,226,.6);font-size:10px;line-height:1.5;}',
      '.chg-legend-row{display:flex;align-items:center;gap:8px;width:100%;min-height:27px;padding:4px 7px;',
      'border:1px solid transparent;border-radius:7px;background:transparent;text-align:left;',
      'transition:background .18s,border-color .18s;}',
      '.chg-legend-head:hover,.chg-legend-row:hover{background:rgba(175,199,235,.07);}',
      '.chg-legend-row[aria-pressed="true"]{background:rgba(175,199,235,.10);border-color:rgba(175,199,235,.2);}',
      '.chg-legend button:focus-visible{outline:2px solid rgba(214,230,255,.85);outline-offset:-2px;}',
      '.chg-legend-swatch{width:7px;height:7px;border-radius:2px;flex:none;background:currentColor;',
      'box-shadow:0 0 7px currentColor;}',
      '.chg-legend-label{flex:1;white-space:nowrap;}',
      '.chg-legend-count{font-variant-numeric:tabular-nums;color:rgba(185,202,226,.65);}',
      '.chg-legend-row[aria-pressed="true"] .chg-legend-count{color:inherit;}',
      '.chg-legend-row[data-empty="1"]{color:rgba(185,202,226,.58);}',
      '.chg-galaxy g[data-chg-pool],.chg-item [data-role="halo"]{transition:opacity .18s ease-out;}',
      '@media(prefers-reduced-motion:reduce){.chg-legend-row,.chg-galaxy g[data-chg-pool],',
      '.chg-item [data-role="halo"]{transition:none;}}',
      '.chg-svg{width:100%;height:100%;display:block;touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none;}',
      '.chg-svg *{user-select:none;-webkit-user-select:none;}',
      '.chg-svg[data-dragging="1"]{cursor:grabbing;}',
      '.chg-svg[data-dragging="1"] .chg-tip{visibility:hidden;}',
      '.chg-galaxy{transition:opacity .34s ease-out, transform .34s ease-out;}',
      '.chg-galaxy[data-out="1"]{opacity:0;pointer-events:none;transform:scale(1.12);}',
      '.chg-item{cursor:pointer;}',
      '.chg-tip{font-size:12px;font-weight:500;fill:#edf3ff;pointer-events:none;',
      'paint-order:stroke;stroke:#070b13;stroke-width:4px;stroke-linejoin:round;',
      'font-family:ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;}',
      '.chg-tip-pool{font-size:12px;fill:rgba(228,238,255,.88);}',
      '.chg-panel{position:absolute;top:10px;right:10px;bottom:125px;width:330px;overflow:auto;',
      'background:rgba(12,18,30,.82);backdrop-filter:blur(14px);',
      'border:1px solid rgba(130,165,220,.18);border-radius:14px;padding:14px 15px;',
      'box-shadow:0 18px 50px rgba(0,0,0,.5);transform:translateX(16px);opacity:0;',
      'transition:transform .34s ease-out, opacity .34s ease-out;}',
      '.chg-panel[data-in="1"]{transform:translateX(0);opacity:1;}',
      '.chg-panel h4{margin:0 0 8px;font-size:14px;line-height:1.45;font-weight:600;}',
      '.chg-pool-tag{display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;margin-bottom:9px;}',
      '.chg-field{margin:9px 0;font-size:11.5px;line-height:1.6;}',
      '.chg-field-k{color:rgba(170,190,220,.6);font-size:10px;letter-spacing:.4px;display:block;margin-bottom:2px;}',
      '.chg-li{margin:3px 0 0 14px;padding:0;}',
      '.chg-li li{margin:2px 0;color:rgba(214,226,244,.86);}',
      '.chg-back{margin-top:12px;width:100%;border:1px solid rgba(140,175,225,.28);',
      'background:rgba(30,42,64,.6);color:rgba(215,228,246,.9);border-radius:9px;padding:6px;',
      'font-size:11.5px;cursor:pointer;}',
      // 详情专用层级；色彩继承现有文字与 col，不影响其他面板。
      '.chg-panel.chg-focus{border-left:4px solid var(--chg-pool-color);padding:18px 18px 16px;',
      'overflow-wrap:anywhere;}',
      '.chg-focus .chg-focus-head{display:flex;align-items:center;min-height:26px;padding-right:32px;margin-bottom:14px;}',
      '.chg-focus .chg-pool-tag{margin-bottom:0;font-size:11px;padding:3px 9px;}',
      '.chg-focus .chg-focus-close{position:absolute;right:12px;top:12px;width:28px;height:28px;',
      'display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:inherit;',
      'font-size:22px;line-height:1;opacity:.65;cursor:pointer;}',
      '.chg-focus .chg-focus-close:hover{opacity:1;background:color-mix(in srgb,currentColor 8%,transparent);}',
      '.chg-focus button:focus-visible{outline:2px solid var(--chg-pool-color);outline-offset:2px;}',
      '.chg-focus h4{font-size:17px;line-height:1.6;font-weight:650;margin:0 0 10px;white-space:pre-wrap;}',
      '.chg-focus .chg-focus-body{font-size:13px;line-height:1.75;opacity:.76;margin:0 0 16px;white-space:pre-wrap;}',
      '.chg-focus .chg-focus-badges{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 20px;}',
      '.chg-focus .chg-focus-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;',
      'border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:999px;',
      'font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.chg-focus .chg-focus-badge-label{opacity:.66;}',
      '.chg-focus .chg-focus-badge[data-used="0"]{opacity:.62;}',
      // 暖色从当前池色派生，未支持相对色的浏览器仍回退到 col。
      '.chg-focus .chg-focus-badge[data-used="1"]{color:var(--chg-pool-color);',
      'color:oklch(from var(--chg-pool-color) .82 .10 65);border-color:currentColor;}',
      '.chg-focus .chg-field{margin:18px 0;}',
      '.chg-focus .chg-field-k{color:inherit;opacity:.65;font-size:10px;letter-spacing:1px;margin-bottom:6px;}',
      '.chg-focus .chg-focus-conclusion{font-size:14px;line-height:1.8;padding:12px 13px;',
      'border-radius:10px;background:color-mix(in srgb,var(--chg-pool-color) 7%,transparent);}',
      '.chg-focus .chg-focus-copy{margin:0;white-space:pre-wrap;}',
      '.chg-focus .chg-focus-evidence{font-size:12px;line-height:1.75;opacity:.68;}',
      '.chg-focus .chg-focus-minor{font-size:11px;line-height:1.7;opacity:.5;}',
      '.chg-focus .chg-li{list-style:none;margin:0;padding:0;}',
      '.chg-focus .chg-li li{position:relative;color:inherit;margin:7px 0;padding-left:12px;white-space:pre-wrap;}',
      '.chg-focus .chg-li li::before{content:"·";position:absolute;left:0;font-weight:700;}',
      '.chg-focus .chg-back{margin-top:18px;padding:9px;}',
      '.chg-receipt-strip{flex:none;padding:6px 16px;font-size:11px;line-height:1.6;color:rgba(226,234,247,.78);background:rgba(12,18,29,.55);border-bottom:1px solid rgba(190,210,242,.09);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.chg-receipt-strip strong{font-weight:550;color:rgba(240,246,255,.93);}',
      '.chg-receipts-list{display:grid;gap:7px;margin-top:10px;}',
      '.chg-receipt-row{border:1px solid rgba(190,210,242,.12);border-radius:9px;padding:9px 11px;font-size:11px;line-height:1.7;}',
      '.chg-receipt-row>summary{cursor:pointer;display:flex;flex-wrap:wrap;justify-content:space-between;gap:3px 10px;}',
      '.chg-receipt-row p{margin:5px 0;opacity:.68;}',
      '.chg-receipt-ids{margin:7px 0;padding-left:20px;max-height:200px;overflow:auto;overflow-wrap:anywhere;font-family:monospace;}',
      '.chg-lexicon{margin:10px 0;max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.7;}',
      '.chg-mood-card{cursor:pointer;outline:none;}',
      '.chg-mood-card:hover rect,.chg-mood-card:focus-visible rect{stroke-opacity:.9;}',
      '.chg-mood-state{margin:12px 0;padding:12px;border:1px solid color-mix(in srgb,var(--chg-pool-color) 20%,transparent);border-radius:10px;}',
      '.chg-mood-state header{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:14px;}',
      '.chg-mood-state header strong{font-variant-numeric:tabular-nums;color:var(--chg-pool-color);}',
      '.chg-mood-meter{height:3px;margin:10px 0;background:color-mix(in srgb,var(--chg-pool-color) 12%,transparent);border-radius:3px;overflow:hidden;}',
      '.chg-mood-meter span{display:block;height:100%;background:var(--chg-pool-color);opacity:.7;}',
      '.chg-mood-state p{font-size:12px;line-height:1.7;opacity:.78;margin:6px 0;overflow-wrap:anywhere;}',
      '.chg-mood-state summary{font-size:11px;opacity:.65;cursor:pointer;margin-top:10px;}',
      '.chg-mood-source{font-size:11px;line-height:1.7;border-left:1px solid var(--chg-pool-color);padding-left:10px;margin:10px 0;overflow-wrap:anywhere;}',
      '.chg-mood-source time,.chg-mood-source small{display:block;opacity:.55;}',
      '.chg-mood-source p{margin:3px 0;white-space:pre-wrap;}',
      '.chg-empty{color:rgba(180,196,222,.55);padding:24px;text-align:center;}',
      // **2026-11-05：开屏那 2 秒**。中心点先亮，十二个外围点延时依次浮现 —— 数据没到也先有形状。
      '.chg-boot{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;}',
      '.chg-boot-core{animation:chg-boot-pulse 1.8s ease-in-out infinite;}',
      '.chg-boot-dot{animation:chg-boot-fade 1.6s ease-in-out infinite;opacity:0;}',
      '@keyframes chg-boot-pulse{0%,100%{opacity:.55;r:3.4;}50%{opacity:1;}}',
      '@keyframes chg-boot-fade{0%{opacity:0;}35%{opacity:.9;}100%{opacity:0;}}',
      '@media (prefers-reduced-motion: reduce){.chg-boot-core,.chg-boot-dot{animation:none;opacity:.7;}}',
      '.chg-set{position:absolute;top:10px;right:10px;width:340px;max-height:calc(100% - 20px);overflow:auto;',
      'background:rgba(10,16,26,.92);backdrop-filter:blur(12px);border:1px solid rgba(130,165,220,.2);',
      'border-radius:12px;padding:12px 13px;font-size:11.5px;box-shadow:0 16px 44px rgba(0,0,0,.5);z-index:5;}',
      '.chg-set-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:13px;}',
      '.chg-set-hint{color:rgba(180,196,222,.6);margin:0 0 8px;line-height:1.5;word-break:break-all;}',
      '.chg-set-globals{display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}',
      '.chg-set-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.chg-set-row input{width:96px;}',
      '.chg-settings{width:370px;max-width:calc(100% - 20px);box-sizing:border-box;}',
      '.chg-settings .chg-set-hd{gap:10px;}',
      '.chg-set-group{margin:9px 0;border:1px solid rgba(130,165,220,.14);border-radius:10px;overflow:hidden;}',
      '.chg-set-group summary{padding:10px 11px;font-size:12px;font-weight:600;cursor:pointer;}',
      '.chg-set-group summary:hover{background:rgba(130,165,220,.06);}',
      '.chg-set-group-body{padding:2px 9px 10px;display:flex;flex-direction:column;gap:8px;}',
      '.chg-set-group select{background:rgba(24,34,52,.9);color:inherit;border:1px solid rgba(130,165,220,.24);',
      'border-radius:7px;padding:5px 8px;font:inherit;}',
      '.chg-set-guide{max-height:310px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;',
      'padding:12px;border:1px solid rgba(130,165,220,.22);border-radius:10px;background:rgba(130,165,220,.05);line-height:1.8;}',
      '.chg-set-guide h3{font-size:13px;margin:0 0 8px;}.chg-set-guide h4{font-size:12px;margin:16px 0 6px;}',
      '.chg-set-guide p{margin:7px 0;}.chg-set-guide ul{margin:6px 0;padding-left:18px;}',
      '.chg-set-confirm{padding:11px;border:1px solid currentColor;border-radius:8px;line-height:1.6;}',
      '.chg-set-confirm p{margin:7px 0;}.chg-set-confirm button+button{margin-left:8px;}',
      '.chg-set-table-wrap{overflow:auto;}.chg-settings .chg-set-table input{width:62px;}',
      '.chg-settings input:disabled,.chg-settings select:disabled{opacity:.5;cursor:wait;}',
      '.chg-settings summary:focus-visible,.chg-settings button:focus-visible,.chg-set-guide:focus-visible{outline:2px solid currentColor;outline-offset:-2px;}',
      '.chg-set-switches{display:flex;flex-direction:column;gap:4px;padding:4px 0 10px;margin-bottom:10px;',
      'border-bottom:1px solid rgba(130,165,220,.16);}',
      '.chg-set-switch{display:flex;align-items:center;justify-content:space-between;gap:14px;',
      'padding:8px;border-radius:8px;background:rgba(130,165,220,.045);cursor:pointer;}',
      '.chg-set-switch strong{display:block;font-size:12px;font-weight:500;}',
      '.chg-set-switch small{display:block;margin-top:3px;font-size:10.5px;line-height:1.5;color:rgba(180,196,222,.65);}',
      '.chg-set-switch input{width:16px;height:16px;flex:none;cursor:pointer;accent-color:var(--dsw-alias-label-primary,#e6edf7);}',
      '.chg-set-switch input:focus-visible{outline:2px solid currentColor;outline-offset:3px;}',
      '.chg-set-table{width:100%;border-collapse:collapse;}',
      '.chg-set-table th{text-align:left;font-weight:500;color:rgba(180,196,222,.65);padding:2px 6px 4px 0;font-size:10.5px;}',
      '.chg-set-table td{padding:1px 6px 1px 0;}',
      '.chg-set-table input{width:64px;}',
    ].join('');

    // 仅叠加阅读态：不改逐帧投影的 opacity、坐标、半径或动画时钟。
    // 选择器从同一份池定义生成；切换时只更新画布属性，不重启 rAF。
    POOL_SPEC.forEach(function (pool) {
      var scope = '.chg-stage[data-pool-focus="' + pool.key + '"] .chg-galaxy ';
      CSS += scope + '[data-chg-pool]:not([data-chg-pool="' + pool.key + '"]){opacity:.12;}'
        + scope + '.chg-pool-ambient:not([data-chg-pool="' + pool.key + '"]){opacity:.015;}'
        + scope + '.chg-item[data-chg-pool="' + pool.key + '"] [data-role="halo"]{opacity:.48;}'
        + scope + '[data-chg-link]:not([data-chg-link~="' + pool.key + '"]){opacity:.015;}';
    });

    function ensureStyle() {
      try {
        if (typeof document === 'undefined') return;
        if (document.querySelector('style[data-plugin="dsh-chain-shared-v16"]')) return;
        var el = document.createElement('style');
        el.setAttribute('data-plugin', 'dsh-chain-shared-v16');
        el.textContent = CSS;
        (document.head || document.body).appendChild(el);
      } catch (e) { /* 样式注不进去不影响渲染 */ }
    }

    /* ════════════ 工具 ════════════ */

    function hash01(s) {
      var v = 2166136261;
      var str = String(s === undefined || s === null ? '' : s);
      for (var i = 0; i < str.length; i += 1) { v ^= str.charCodeAt(i); v = Math.imul(v, 16777619); }
      return ((v >>> 0) % 100000) / 100000;
    }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function shortDate(ts) {
      var t = Date.parse(String(ts || ''));
      if (!isFinite(t)) return '';
      var d = new Date(t);
      return (d.getMonth() + 1) + '-' + d.getDate();
    }
    function poolColor(k) { return (POOL_MAP[k] || { color: '#dfe8ff' }).color; }
    function poolLabel(k) { return (POOL_MAP[k] || { label: k }).label; }

    /**
     * 年龄的写法（2026-10-30 改）：不到 1 天就按小时说。
     *
     * 原来 Math.round(ageDays) → 0.2 天也显示「0 天」，看着像"刚写的"，
     * 而它其实已经过了一晚。**显示粒度不该撒谎。**
     */
    function ageText(ageDays) {
      const d = Number(ageDays);
      if (!Number.isFinite(d) || d < 0) return '0 小时';
      if (d < 1) return Math.max(1, Math.round(d * 24)) + ' 小时';
      return Math.round(d) + ' 天';
    }

    /* ════════════ 力导向布局（算一次冻结，三维坐标） ════════════ */

    function computeLayout(graphNodes) {
      var mem = []; var evi = [];
      for (var i = 0; i < graphNodes.length; i += 1) {
        if (graphNodes[i].kind === 'evidence') evi.push(graphNodes[i]); else mem.push(graphNodes[i]);
      }
      var byPool = {};
      for (var mi = 0; mi < mem.length; mi += 1) {
        var kk = mem[mi].pool || 'dailyPartial';
        // 兼容：接口若还回老的 'skill'（或未知池），归到经验那颗星上 ——
        // 铁律/经验是 2026-10-30 才拆的，缓存里的旧数据不能把星图打空。
        if (kk === 'skill' || !POOL_MAP[kk]) kk = kk === 'skill' ? 'skillExp' : kk;
        if (!byPool[kk]) byPool[kk] = [];
        byPool[kk].push(mem[mi]);
      }
      var keys = [];
      for (var si = 0; si < POOL_SPEC.length; si += 1) keys.push(POOL_SPEC[si].key);
      for (var bk in byPool) if (keys.indexOf(bk) < 0) keys.push(bk);

      var pos = {}; var pools = [];
      for (var k2 = 0; k2 < keys.length; k2 += 1) {
        // **七个大节点的位置随机**（用户 2026-10-28 定），但**不要铺太远**：
        // 角度全随机、半径限制在 0.26–0.54 —— 随机感有，但还在画面中圈。
        var a = hash01(keys[k2] + 'ang') * 6.283;
        // **半径交替拉开**：原来全是 0.5，七个池必然挤成一圈"一块板"。
        // 大小穿插 + 相位错开，团与团之间才有空隙。
        // **七个池连成一个环**（用户 2026-10-28 定：要「圈团」不是「铺开」）。
        // 半径基本一致 + 少量抖动 → 像一圈星团，中间留空；差异太大就散成几块。
        // **大节点全贴一起**（2026-10-30 用户定）：原来 0.26–0.54 铺得太开，
        // 3D 看着是"一片散点"；收紧到 0.10–0.26，团与团挨着，纵深才显饱满。
        // 代价是团可能互相压 —— 用户自己说了：只要小节点不撞，大节点贴一起就行。
        var rr0 = 0.10 + hash01(keys[k2] + 'rad') * 0.16;
        var pc = {
          key: keys[k2],
          cx: Math.cos(a) * rr0,
          cy: Math.sin(a) * rr0,
          // **池心也要有纵深**（2026-10-29 加）：七个池心原来全在同一个平面上，
          // 云一转就露馅 —— 转到 90° 时整圈池心压成一条竖线，所有团叠在一起。
          // 实测：那时投影重叠从 2 对跳到 19 对，是"截图看着乱"的最大来源。
          // 按序号均匀铺开 0.62 的纵深，环就变成三维的了。
          cz: ((keys.length > 1 ? k2 / (keys.length - 1) : 0.5) - 0.5) * 0.68,   // 1.15：sweep3 实测最优（90° 视角不再压成一条线）
          r0: rr0,
          a0: a,
          count: (byPool[keys[k2]] || []).length,
          // 每个池自己的公转速率与相位（大节点不再一起转）
          rate: 0.012 + hash01(keys[k2] + 'rate') * 0.020,
          spin: 0.016 + hash01(keys[k2] + 'spin') * 0.028,
          ph: hash01(keys[k2] + 'ph') * 6.283,
        };
        pools.push(pc);
        pos['pool:' + pc.key] = pc;
      }
      /* ── 池内铺点：**球面上的黄金角螺旋**（2026-10-29 改，取代"随机角度撒点"）──
       *
       * 这条改了三轮，前面两轮都被指标否掉了，值得把过程写下来：
       *
       *   ① 随机角度撒点（原版）：随机必有近距尾巴 —— 8 个转角平均有 4.9 对点 <0.012。
       *   ② 平面黄金角螺旋 + 收窄纵深：只看 rotY=0 时光学上更好，
       *      但**90°/270° 反而炸了**（7→22 对）。原因：转角到 90° 时屏幕上只剩下
       *      「纵深 × 高度」，我把纵深从 0.9 收到 0.52，等于把那个视角拆了。
       *      → **教训：这是个旋转的 3D 云，只优化一个角度一定会牺牲别的角度。**
       *   ③ 现在这个：**斐波那契球面**（Fibonacci sphere）—— 点均匀铺在球面上，
       *      半径按 ∛i 递增（体积均匀）。**各方向一样厚，转到哪都一样**，
       *      所以不用再为某个视角做取舍。
       *
       * 池子半径按 ∛n 自动缩放：点数多的池自己铺大，少的收紧。
       */
      // **三个固定锚点**（2026-10-30 用户定的分区）：
      //   感知区在左（白粉：情绪那一团）、决策区在右后（紫）、元记忆区在右前（橙）。
      // 用归一化坐标写死，比跟着随机环走更容易"一眼看出三个区"。
      // 情绪池钉在感知区；留一点自转，别像贴纸
      for (var zi = 0; zi < pools.length; zi += 1) {
        var zk = pools[zi].key;
        var zt = zk === 'emotion' ? ZONES.sense
          : (zk === 'decision' ? ZONES.decide
            : (zk === 'meta' ? ZONES.meta
              : (zk === 'hippocampus' ? ZONES.hippo : null)));
        if (zt) {
          pools[zi].cx = zt.x;
          pools[zi].cy = zt.y;
          pools[zi].cz = zt.z;
          pools[zi].r0 = Math.sqrt(zt.x * zt.x + zt.y * zt.y);
          pools[zi].a0 = Math.atan2(zt.y, zt.x);
          // 三个区钉住之后不再公转（区域是"地标"，不是行星）
          pools[zi].rate = 0;
        }
      }

      var memByPool = {};
      for (var g0 = 0; g0 < mem.length; g0 += 1) {
        var gk = mem[g0].pool || 'dailyPartial';
        if (!memByPool[gk]) memByPool[gk] = [];
        memByPool[gk].push(mem[g0]);
      }
      var GOLDEN = 2.39996323;   // 黄金角（弧度）
      // **中央球**（2026-10-30）：主体从"太空"变成一个球，卫星绕着它 —— 星链那种感觉
      var poolIdx = {};
      for (var pidx = 0; pidx < pools.length; pidx += 1) poolIdx[pools[pidx].key] = pidx;
      for (var gk2 in memByPool) {
        var group = memByPool[gk2];
        var pc2 = pos['pool:' + gk2];
        if (!pc2) continue;
        // 稳定顺序：同一批数据每次打开排出来一样（不然"复位"会跳）
        group.sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
        var n = group.length;
        // **点球 + 赤道亮环**（2026-10-30 照用户给的两张图改）
        //
        // 图1：一个球，表面密密麻麻铺满小点，边缘暖光，球上有几块彩色斑；
        // 图2：星链，地球外面一圈发光的环带。
        // 所以不是"几条轨道绕球转"，而是**点的密度自己画出球**，再加一条赤道亮带。
        // **四个功能区不进球**（2026-10-30）：它们是"站在外面看球"的四个站，
        // 一旦混进球面，球就不圆了、四块也分不清。这里各自锚点附近团一小块。
        if (ZONE_KEYS[gk2]) {
          var zk2 = gk2 === 'emotion' ? ZONES.sense
            : (gk2 === 'decision' ? ZONES.decide
              : (gk2 === 'meta' ? ZONES.meta : ZONES.hippo));
          var zn = group.length;
          for (var zi2 = 0; zi2 < zn; zi2 += 1) {
            var zm = group[zi2];
            var zr = 0.030 + 0.016 * Math.cbrt(zn);
            var zAng = hash01(zm.id + 'za') * 6.283;
            var zRad = Math.cbrt((zi2 + 1) / Math.max(1, zn)) * zr;
            pos[zm.id] = {
              x: zk2.x + Math.cos(zAng) * zRad,
              y: zk2.y + (hash01(zm.id + 'zy') - 0.5) * zr,
              z: zk2.z + Math.sin(zAng) * zRad,
              key: gk2,
            };
          }
          continue;
        }
        // 功能区不占球面方向，否则六块斑只会覆盖十个方向中的一部分。
        var surfaceKeys = POOL_SPEC.filter(function (p) { return !ZONE_KEYS[p.key]; }).map(function (p) { return p.key; });
        var capIdx = Math.max(0, surfaceKeys.indexOf(gk2));
        var capN = Math.max(1, surfaceKeys.length);
        var capYv = 1 - (capIdx + 0.5) * 2 / capN;
        var capRr = Math.sqrt(Math.max(0, 1 - capYv * capYv));
        var capThetaV = capIdx * 2.39996323;
        var capCx = capRr * Math.cos(capThetaV);
        var capCz = capRr * Math.sin(capThetaV);
        var capAngle = 0.62 + Math.min(0.30, 0.08 * Math.cbrt(n));
        for (var gi = 0; gi < n; gi += 1) {
          var gm = group[gi];
          if ((gi % 4) === 3) {
            // 赤道亮带：每 4 个点里 1 个，半径略大、y 很小 → 一圈发光的环
            var bandAng = hash01(gm.id + 'ba') * 6.283;
            var bandR = SPHERE_R * (1.045 + hash01(gm.id + 'br') * 0.05);
            pos[gm.id] = {
              x: Math.cos(bandAng) * bandR,
              y: (hash01(gm.id + 'by') - 0.5) * SPHERE_R * 0.16,
              z: Math.sin(bandAng) * bandR,
              key: gk2,
            };
            continue;
          }
          // 球面上属于本池的那块"斑"：在球冠中心方向附近扰动，再归一化回球面
          var jx = (hash01(gm.id + 'x') - 0.5) * 2;
          var jy = (hash01(gm.id + 'y') - 0.5) * 2;
          var jz = (hash01(gm.id + 'z') - 0.5) * 2;
          var jl = Math.sqrt(jx * jx + jy * jy + jz * jz) || 1;
          var kk2 = (hash01(gm.id + 'k') * capAngle) / jl;
          var dx = capCx + jx * kk2;
          var dy = capYv + jy * kk2;
          var dz = capCz + jz * kk2;
          var dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          var rr2 = SPHERE_R * (0.985 + hash01(gm.id + 'rr') * 0.030);
          pos[gm.id] = {
            x: (dx / dl) * rr2,
            y: (dy / dl) * rr2,
            z: (dz / dl) * rr2,
            key: gk2,
          };
        }
      }

      for (var i4 = 0; i4 < evi.length; i4 += 1) {
        var e = evi[i4];
        var parent = pos[e.parent];
        if (!parent) continue;
        var ea = hash01(e.id) * Math.PI * 2;
        var er = 0.028 + hash01(e.id + 'r') * 0.038;
        pos[e.id] = {
          x: parent.x + Math.cos(ea) * er,
          y: parent.y + Math.sin(ea) * er,
          z: (parent.z || 0) + (hash01(e.id + 'z') - 0.5) * 0.26,
          key: parent.key,
        };
      }

      // **星球模式**（2026-10-30 用户定）：不再用力导向揉位置 —— 它会把环链揉成散沙、
      // 把池心推得远近不一，正是用户说的《3D 太乱》。ITER=0 直接关掉。
      var ITER = 0;
      for (var it = 0; it < ITER; it += 1) {
        var cool = 0.9 * (1 - it / ITER) + 0.1;
        for (var a1 = 0; a1 < pools.length; a1 += 1) {
          var p1 = pools[a1];
          var fx1 = -p1.cx * 0.55; var fy1 = -p1.cy * 0.55;
          for (var b1 = 0; b1 < pools.length; b1 += 1) {
            if (a1 === b1) continue;
            var p2 = pools[b1];
            var dx1 = p1.cx - p2.cx; var dy1 = p1.cy - p2.cy;
            var d21 = dx1 * dx1 + dy1 * dy1 + 1e-4;
            var f1 = 0.052 / d21;
            fx1 += dx1 * f1; fy1 += dy1 * f1;
          }
          p1.cx += fx1 * cool; p1.cy += fy1 * cool;
        }
        for (var a2 = 0; a2 < mem.length; a2 += 1) {
          var m2 = mem[a2]; var q2 = pos[m2.id]; var c2 = pos['pool:' + q2.key];
          var fx2 = (c2.cx - q2.x) * 0.095;
          var fy2 = (c2.cy - q2.y) * 0.095;
          for (var b2 = 0; b2 < mem.length; b2 += 1) {
            if (a2 === b2) continue;
            var r2 = pos[mem[b2].id];
            var dx2 = q2.x - r2.x; var dy2 = q2.y - r2.y;
            var d22 = dx2 * dx2 + dy2 * dy2 + 1e-5;
            if (d22 > 0.09) continue;
            var f2 = 0.00042 / d22;
            fx2 += dx2 * f2; fy2 += dy2 * f2;
          }
          q2.x += fx2 * cool; q2.y += fy2 * cool;
        }
      }

      var xs = []; var ys = [];
      for (var a3 = 0; a3 < pools.length; a3 += 1) { xs.push(pools[a3].cx); ys.push(pools[a3].cy); }
      for (var a4 = 0; a4 < mem.length; a4 += 1) { xs.push(pos[mem[a4].id].x); ys.push(pos[mem[a4].id].y); }
      var mx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2;
      var my = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
      var span = Math.max(
        (Math.max.apply(null, xs) - Math.min.apply(null, xs)) / 2,
        (Math.max.apply(null, ys) - Math.min.apply(null, ys)) / 2,
      ) || 1;
      span *= 1.12;   // 稍微留白，团与团之间才有呼吸
      // 记下"画图用的球半径"：下面的坐标都会被 span 除，光圈必须跟着同一个尺度
      // 三轴必须保持同一尺度，否则二维归一化会扭曲球面。
      mx = 0; my = 0; span = 1;
      SPHERE_R_DRAW = SPHERE_R;
      for (var p3 = 0; p3 < pools.length; p3 += 1) {
        pools[p3].cx = (pools[p3].cx - mx) / span;
        pools[p3].cy = (pools[p3].cy - my) / span;
      }
      for (var a5 = 0; a5 < mem.length; a5 += 1) {
        var q3 = pos[mem[a5].id];
        q3.x = (q3.x - mx) / span;
        q3.y = (q3.y - my) / span;
      }


      /* ── 七个池心归到同一个环上（2026-10-29 修）────────────────────────
       *
       * 为什么要这一步：力导向的斥力会把某个池推到接近中心
       * （实测环半径 0.150–0.768，差 5 倍），那个池的小点就铺满画面中央 ——
       * 看起来"小点没围着大点、自己飞出去一坨"。
       * 方位角保留（看着仍是随机的一圈），只把**半径**统一到 0.42±0.05。
       * 池内小点是绝对坐标，所以池心搬家时它们必须跟着搬，否则会脱节。
       */
      // **大节点坐在球面上**（2026-10-30 点球版）：它们标的是"这块斑的中心"，
      // 而且**不再平移小点** —— 小点属于球面，不属于池心；一平移，球就被撕成六个偏移的球。
      for (var pr = 0; pr < pools.length; pr += 1) {
        var pp = pools[pr];
        if (ZONE_KEYS[pp.key]) continue;
        var surfaceKeys2 = POOL_SPEC.filter(function (p) { return !ZONE_KEYS[p.key]; }).map(function (p) { return p.key; });
        var ci2 = Math.max(0, surfaceKeys2.indexOf(pp.key));
        var cn2 = Math.max(1, surfaceKeys2.length);
        var cy2 = 1 - (ci2 + 0.5) * 2 / cn2;
        var cr2 = Math.sqrt(Math.max(0, 1 - cy2 * cy2));
        var ct2 = ci2 * 2.39996323;
        pp.cx = cr2 * Math.cos(ct2) * SPHERE_R * 1.02;
        pp.cy = cy2 * SPHERE_R * 1.02;
        pp.cz = cr2 * Math.sin(ct2) * SPHERE_R * 1.02;
        pp.r0 = Math.sqrt(pp.cx * pp.cx + pp.cy * pp.cy);
        pp.a0 = Math.atan2(pp.cy, pp.cx);
        pp.rate = 0;   // 球面上的"大陆"不公转
      }



      /* ── 每池小点群半径：显式设定（2026-10-29）─────────────────────────
       *
       * 前面调的都是布局阶段的相对参数，而**归一化会按 span 除一遍** ——
       * 团缩小、span 也缩小，除完比例不变（k 从 1.2 调到 0.5，实测群半径一模一样）。
       * 所以这里在归一化和归环之后，直接按点数算目标半径再缩放。
       *   target = 0.045 × ∛n
       *   87 条 → 0.20（相对环半径 0.46 是 0.43）；32 条 → 0.143；1 条 → 0.045
       */
      // 星链布局下不再按点数缩放 —— 轨道壳的半径是显式给的，缩放会把壳压回小球
      for (var sz = 0; sz < 0; sz += 1) {
        var szPool = pools[sz];
        var szIds = [];
        for (var szi = 0; szi < mem.length; szi += 1) {
          if ((mem[szi].pool || 'dailyPartial') === szPool.key) szIds.push(mem[szi].id);
        }
        if (szIds.length === 0) continue;
        var szTarget = 0.062 * Math.cbrt(szIds.length);
        var szMax = 0;
        for (var szj = 0; szj < szIds.length; szj += 1) {
          var szP = pos[szIds[szj]];
          var szDx = szP.x - szPool.cx;
          var szDy = szP.y - szPool.cy;
          var szDz = (szP.z || 0) - (szPool.cz || 0);
          var szD = Math.sqrt(szDx * szDx + szDy * szDy + szDz * szDz);
          if (szD > szMax) szMax = szD;
        }
        if (szMax < 1e-6) continue;
        var szK = szTarget / szMax;
        for (var szk = 0; szk < szIds.length; szk += 1) {
          var szQ = pos[szIds[szk]];
          szQ.x = szPool.cx + (szQ.x - szPool.cx) * szK;
          szQ.y = szPool.cy + (szQ.y - szPool.cy) * szK;
          szQ.z = (szPool.cz || 0) + ((szQ.z || 0) - (szPool.cz || 0)) * szK;
        }
      }


      /* ── 证据点钉回父节点（2026-10-29 补）────────────────────────────
       *
       * 上面把池心归了环、把每个池的小点群按点数缩放了，但**证据点没跟着动** ——
       * 它们的坐标还是归一化之前的，于是散在离父点很远的地方，
       * 看上去就是"一堆细白点在空中乱飞"。这里统一重钉一次：
       * 父点位置 + 一个由 id 决定的小偏移（半径约 0.03，方向随机但确定）。
       */
      for (var ev2 = 0; ev2 < evi.length; ev2 += 1) {
        var evn = evi[ev2];
        var evParent = pos[evn.parent];
        if (!evParent) continue;
        var evAng = hash01(evn.id + 'ea') * 6.283;
        var evR = 0.018 + hash01(evn.id + 'er') * 0.022;
        pos[evn.id] = {
          x: evParent.x + Math.cos(evAng) * evR,
          y: evParent.y + Math.sin(evAng) * evR,
          z: (evParent.z || 0) + (hash01(evn.id + 'ez') - 0.5) * 0.05,
          key: evParent.key,
        };
      }

      // 池心代表组织单元，收进地核；功能区仍在外围承担真实事件处理。
      var coreAxes = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
      var coreIndex = 0;
      pools.forEach(function (pool) {
        if (ZONE_KEYS[pool.key]) return;
        var axis = coreAxes[coreIndex++ % coreAxes.length];
        pool.cx = axis[0] * 0.074; pool.cy = axis[1] * 0.074; pool.cz = axis[2] * 0.074;
        pool.r0 = Math.hypot(pool.cx, pool.cy); pool.a0 = Math.atan2(pool.cy, pool.cx); pool.rate = 0;
      });
      mem.forEach(function (node) { pos[node.id] = memoryPosition(node); });
      evi.forEach(function (node) {
        var parent = pos[node.parent]; if (!parent) return;
        var angle = hash01(node.id) * Math.PI * 2;
        pos[node.id] = { x: parent.x + Math.cos(angle)*0.012,
          y: parent.y + Math.sin(angle)*0.012, z: parent.z, key: parent.key };
      });
      return { pos: pos, pools: pools, mem: mem, evi: evi };
    }

    // 初始与增量共用稳定的 id 坐标；新增一条不会把旧节点挤走或重排。
    function memoryPosition(node) {
      var key = node.pool || 'dailyPartial';
      if (ZONE_KEYS[key]) {
        var zone = key === 'emotion' ? ZONES.sense : key === 'decision' ? ZONES.decide : key === 'meta' ? ZONES.meta : ZONES.hippo;
        var a = hash01(node.id + 'zone') * Math.PI * 2;
        var r = 0.065 * Math.sqrt(hash01(node.id + 'zone-radius'));
        return { x: zone.x + Math.cos(a)*r, y: zone.y + Math.sin(a)*r,
          z: zone.z + (hash01(node.id+'zone-depth')-0.5)*0.06, key: key };
      }
      var keys = POOL_SPEC.filter(function (p) { return !ZONE_KEYS[p.key]; }).map(function (p) { return p.key; });
      var index = Math.max(0, keys.indexOf(key));
      var centerY = 1 - (index+0.5)*2/keys.length;
      var phase = index*2.39996323;
      var center = [Math.sqrt(1-centerY*centerY)*Math.cos(phase),centerY,Math.sqrt(1-centerY*centerY)*Math.sin(phase)];
      var phi = hash01(node.id+'surface-angle')*Math.PI*2;
      var cosTheta = 1-hash01(node.id+'surface-area')*(1-Math.cos(0.72));
      var sinTheta = Math.sqrt(1-cosTheta*cosTheta);
      var tangent = [-Math.sin(phase),0,Math.cos(phase)];
      var bitangent = [center[1]*tangent[2],center[2]*tangent[0]-center[0]*tangent[2],-center[1]*tangent[0]];
      var radius = SPHERE_R*(0.985+0.03*hash01(node.id+'surface-radius'));
      var point = center.map(function (v,i) { return radius*(v*cosTheta + sinTheta*(tangent[i]*Math.cos(phi)+bitangent[i]*Math.sin(phi))); });
      if (hash01(node.id+'band-select') < 0.25) {
        var angle = hash01(node.id+'band-angle')*Math.PI*2;
        radius = SPHERE_R*(1.045+0.05*hash01(node.id+'band-radius'));
        point = [Math.cos(angle)*radius,(hash01(node.id+'band-y')-0.5)*SPHERE_R*0.16,Math.sin(angle)*radius];
      }
      return { x: point[0], y: point[1], z: point[2], key: key };
    }

    /* ════════════ 视图 ════════════ */

    // 短弧保留真实端点；中段略高于球面，避免直线弦穿过球体。
    function relationArc(a, b) {
      var ra = Math.hypot(a[0], a[1], a[2]);
      var rb = Math.hypot(b[0], b[1], b[2]);
      if (ra < 1e-8 || rb < 1e-8) return [a, b];
      var u = a.map(function (v) { return v / ra; });
      var v = b.map(function (value) { return value / rb; });
      var dot = Math.max(-1, Math.min(1, u[0]*v[0] + u[1]*v[1] + u[2]*v[2]));
      var angle = Math.acos(dot);
      var tangent = v.map(function (value, i) { return value - u[i] * dot; });
      var length = Math.hypot(tangent[0], tangent[1], tangent[2]);
      if (length < 1e-8) {
        // 对跖节点有多个等长短弧，选固定正交方向，避免逐帧翻转。
        var axis = Math.abs(u[0]) < 0.8 ? [1,0,0] : [0,1,0];
        var projection = axis[0]*u[0] + axis[1]*u[1] + axis[2]*u[2];
        tangent = axis.map(function (value, i) { return value - projection * u[i]; });
        length = Math.hypot(tangent[0], tangent[1], tangent[2]);
      }
      tangent = tangent.map(function (value) { return value / length; });
      var points = [a];
      for (var i = 1; i < 24; i += 1) {
        var t = i / 24;
        var radius = ra * (1-t) + rb * t + Math.sin(Math.PI*t) * 0.012;
        points.push(u.map(function (value, k) {
          return (value * Math.cos(angle*t) + tangent[k] * Math.sin(angle*t)) * radius;
        }));
      }
      points.push(b);
      return points;
    }

    function ChainGraphView(props) {
      void props;
      ensureStyle();

      var [data, setData] = React.useState(null);
      var [error, setError] = React.useState(null);
      var [focus, setFocus] = React.useState(null);
      var [panelIn, setPanelIn] = React.useState(false);
      var [size, setSize] = React.useState({ w: 900, h: 620 });
      var [spin, setSpin] = React.useState(true);   // 当前要求：缓慢自转常驻。
      var [labels, setLabels] = React.useState(false);
      var [legendOpen, setLegendOpen] = React.useState(true);
      var [activePool, setActivePool] = React.useState(null);
      // 设置面板（右上角齿轮）。**放在自己的画布里**，不走宿主设置页 ——
      // 那套要 plugins.item 槽位 + configForms，接了两轮才通；自己开接口更直接。
      var [showSettings, setShowSettings] = React.useState(false);
      // **三层面板**（2026-10-30）：感知 / 决策 / 元记忆各一块 ——
      // 这三层以前只活在日志里，用户看不见；现在挂到画布上，点一下就摊开。
      var [showLayers, setShowLayers] = React.useState(false);
      // **连线默认关**（2026-10-30 用户连着两轮说“乱”）：星链本身没有连线，
      // 而那些横穿画面的 related 边把 199 个点缝成一张网 —— 乱的就是它们。
      // 需要看关系时按「连线」再开。
      var [showLines, setShowLines] = React.useState(true);
      var [moodData, setMoodData] = React.useState(null);
      var [latestReceipt, setLatestReceipt] = React.useState(null);
  // 夜巡状态：跑了却看不见 = 等于没跑（2026-10-30 用户说"等了两分钟没动"才发现）
  var [patrolState, setPatrolState] = React.useState(null);

      // 情绪牌只显示事件流里的真实状态；空记录不制造当前心情。
      React.useEffect(function () {
        var alive = true;
        function refresh() {
          fetch('/chain-shared/api/patrol').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) { if (v) setPatrolState(v); })
      .catch(function () { /* 夜巡状态取不到不影响画布 */ });
          fetch('/chain-shared/api/receipts?limit=1').then(function (r) { if (!r.ok) throw Error('receipts'); return r.json(); })
            .then(function (j) { if (alive) setLatestReceipt(Array.isArray(j.receipts) ? j.receipts[0] || null : null); })
            .catch(function () { if (alive) setLatestReceipt(null); });
    fetch('/chain-shared/api/moods?limit=20').then(function (r) { if (!r.ok) throw Error('moods'); return r.json(); })
            .then(function (j) { if (alive) setMoodData(j); })
            .catch(function () { if (alive) setMoodData({ states: [], events: [], error: '暂时无法读取情绪状态' }); });
        }
        refresh(); var timer = window.setInterval(refresh, 2000);
        return function () { alive = false; window.clearInterval(timer); };
      }, []);

      // **动画只由真实事件驱动**（2026-10-30 验收项 8/9）：
      // 每 2 秒问一次后端"这轮联想到了谁"，seq 没变就什么都不做。
      React.useEffect(function () {
        var alive = true;
        function poll() {
          fetch('/chain-shared/api/pulse', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (p) {
              if (!alive || !p) return;
              if (p.seq === undefined) return;
              // 首次连上只对齐 seq，不演 —— 否则一打开页面就会回放上一轮的动画
              if (pulseRef.current.seq === -1) { pulseRef.current.seq = p.seq; return; }
              // **逐拍消费队列**（2026-10-30）：后端现在保留最多 3 拍，
              // 只比较"最新 seq"会把两次轮询之间的注入整段丢掉。
              const beats = Array.isArray(p.queue) && p.queue.length > 0 ? p.queue : [p];
              const fresh = beats.filter((b) => Number(b.seq) > pulseRef.current.seq);
              if (fresh.length === 0) return;
              pulseRef.current.seq = Math.max.apply(null, fresh.map((b) => Number(b.seq)));
              const beat = fresh.find((b) => !b.fallback && Array.isArray(b.seeds) && b.seeds.length > 0);
              if (!beat) return;
              // fallback 已在上面挑 beat 时判过：这里只播**真的形成了联想**的那一拍
              var ids = (beat.seeds || []).slice(0, 3);
              if (ids.length === 0) return;
              var fl = flowRef.current;
              fl.t0 = frameNo.current / 30;
              fl.last = fl.t0;
              fl.ids = ids;
              fl.labels = pulseRef.current.labels;
              // 记账后重新读真实次数，不能拿旧快照或在前端自行加一。
              fetch('/chain-shared/api/graph').then(function (r) { return r.json(); }).then(function (j) {
                if (!alive || !layoutRef.current) return;
                var fresh = {}; (j.nodes || []).forEach(function (n) { fresh[n.id] = n; });
                layoutRef.current.mem.forEach(function (n) { if (fresh[n.id]) Object.assign(n, fresh[n.id]); });
                setData(j);
              }).catch(function () {});
            })
            .catch(function () { /* 接口不通就当没有事件 */ });
        }
        poll();
        var t = setInterval(poll, 2000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      var elMap = React.useRef({});
      var dataRef = React.useRef(null);   // 轮询里要读最新数据，不能靠闭包里的旧 data
      var rotRef = React.useRef({ rotY: 0, rotX: -0.30, zoom: 1.4, vel: 0 });
      var dragRef = React.useRef({ on: false, x: 0, y: 0, moved: 0 });
      var layoutRef = React.useRef(null);
      // 动线状态：哪些节点正在"被想起"、从什么时候开始、从哪儿出发
      var flowRef = React.useRef({ ids: [], t0: 0, last: 0, from: { x: 0, y: 0, z: 0 } });
      // 上一帧的数据指纹：只有**真的变了**才演一次动线 —— 静默时一格动画都不该有
      var lastSigRef = React.useRef('');
      // **真实脉冲**：seq 变了才是新的一轮；没变就一个像素都不动。
      var pulseRef = React.useRef({ seq: -1, labels: {} });
      var stageRef = React.useRef(null);
      var spinRef = React.useRef(spin);
      spinRef.current = spin;
      var frameNo = React.useRef(0);
      var animRef = React.useRef(null);   // id -> {x,y,z} 显示位置（弹簧追目标）
      var openRef = React.useRef({ p: 0.06 });   // 小尺度起步才看得清展开，终点仍保留大视野。

      React.useEffect(function () {
        var alive = true;
        fetch('/chain-shared/api/graph', { headers: { accept: 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (j) { if (alive) setData(j); })
          .catch(function (e) { if (alive) setError(String(e && e.message ? e.message : e)); });
        return function () { alive = false; };
      }, []);

      // **实时增量**：每 9 秒拉一次，只把"新的"补进图里。
      // ⚠️ 绝不重跑 computeLayout —— 那会让所有已有节点重新洗牌，整张图跳一下。
      React.useEffect(function () {
        var stopped = false;
        var timer = 0;

        function addOne(node, jdata) {
          var laid = layoutRef.current;
          if (!laid || laid.pos[node.id]) return false;
          var isEvi = node.kind === 'evidence';
          var anchor = null;
          var poolKey = node.pool || 'dailyPartial';
          if (isEvi) {
            anchor = laid.pos[node.parent] || null;
            if (!anchor) return false;
          } else {
            anchor = laid.pos['pool:' + poolKey] || null;
          }
          var ax = anchor ? (typeof anchor.x === 'number' ? anchor.x : anchor.cx) : 0;
          var ay = anchor ? (typeof anchor.y === 'number' ? anchor.y : anchor.cy) : 0;
          // 池心现在带纵深（cz）；证明点挂在记忆点上（有 z），两条都要认。
          var az = anchor
            ? (typeof anchor.z === 'number' ? anchor.z : (typeof anchor.cz === 'number' ? anchor.cz : 0))
            : 0;
          var ang = hash01(node.id) * 6.283;
          var rr = isEvi
            ? 0.030 + hash01(node.id + 'r') * 0.040
            : 0.055 + hash01(node.id + 'r') * 0.115;
          var zz = az + (hash01(node.id + 'z') - 0.5) * (isEvi ? 0.26 : 0.9);
          laid.pos[node.id] = {
            x: ax + Math.cos(ang) * rr,
            y: ay + Math.sin(ang) * rr,
            z: zz,
            key: isEvi ? (anchor.key || poolKey) : poolKey,
          };
          // 增量不能再围地核随机撒点，否则新记忆会全部陷在中心。
          if (!isEvi) laid.pos[node.id] = memoryPosition(node);
          zz = laid.pos[node.id].z;
          if (isEvi) {
            laid.evi.push(node);
          } else {
            laid.mem.push(node);
            for (var pi = 0; pi < laid.pools.length; pi += 1) {
              if (laid.pools[pi].key === poolKey) laid.pools[pi].count += 1;
            }
            var spool = laid.pos['pool:' + poolKey];
            if (spool && animRef.current) {
              var nOx = laid.pos[node.id].x - spool.cx;
              var nOy = laid.pos[node.id].y - spool.cy;
              animRef.current[node.id] = {
                ox: nOx,
                oy: nOy,
                oz: zz - (spool.cz || 0),
                // 轨道参数必须和种子那边一致，否则新点会走另一种运动
                orr: Math.sqrt(nOx * nOx + nOy * nOy),
                oa: Math.atan2(nOy, nOx),
                ow: 0.014 + hash01(node.id + 'w') * 0.22,
                of: 0.70 + hash01(node.id + 'f') * 0.22,
                oi: (hash01(node.id + 'i') - 0.5) * 1.5,
                oh: hash01(node.id + 'h') * 6.283,
                x: laid.pos[node.id].x,
                y: laid.pos[node.id].y,
                z: zz,
                b: 0,          // 出生进度：0→1（0.6 秒长出来）
              };
            }
          }
          return true;
        }

        function pull() {
          fetch('/chain-shared/api/graph', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (stopped || !layoutRef.current) return;
              var added = 0;
              var nodes = j.nodes || [];
              for (var i = 0; i < nodes.length; i += 1) {
                if (addOne(nodes[i], j)) added += 1;
              }
              var oldTotal = (dataRef.current && dataRef.current.stats) ? dataRef.current.stats.total : -1;
              var newTotal = (j.stats && j.stats.total) ? j.stats.total : -1;
              // 只在"真的有新增 / 总数变了"时重渲染，避免每 9 秒白刷一次
              if (added > 0 || newTotal !== oldTotal) {
                setData(j);
              }
            })
            .catch(function () { /* 拉失败就算了，下一轮再试 */ });
        }

        timer = window.setInterval(pull, 9000);
        return function () {
          stopped = true;
          window.clearInterval(timer);
        };
      }, []);

      React.useEffect(function () {
        function measure() {
          var el = stageRef.current;
          if (!el) return;
          var w = el.clientWidth || 900;
          var hh = el.clientHeight || 620;
          setSize(function (old) {
            if (Math.abs(old.w - w) < 2 && Math.abs(old.h - hh) < 2) return old;
            return { w: w, h: hh };
          });
        }
        measure();
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('resize', measure);
          return function () { window.removeEventListener('resize', measure); };
        }
        return undefined;
      }, []);

      dataRef.current = data;
      if (data && !layoutRef.current && data.nodes) {
        layoutRef.current = computeLayout(data.nodes);
        var seedAnim = {};
        for (var si2 = 0; si2 < layoutRef.current.mem.length; si2 += 1) {
          var sm = layoutRef.current.mem[si2];
          var sp2 = layoutRef.current.pos[sm.id];
          // 记住**相对池心的偏移**，之后绕池心转
          var spool = layoutRef.current.pos['pool:' + sp2.key];
          // 轨道参数（2026-10-29）：半径固定 + 自己的角速度 + 压扁系数
          var sOx = sp2.x - spool.cx;
          var sOy = sp2.y - spool.cy;
          seedAnim[sm.id] = {
            ox: sOx, oy: sOy, oz: (sp2.z || 0) - (spool.cz || 0),
            orr: Math.sqrt(sOx * sOx + sOy * sOy),
            oa: Math.atan2(sOy, sOx),
            ow: 0.014 + hash01(sm.id + 'w') * 0.22,
            of: 0.70 + hash01(sm.id + 'f') * 0.22,
            // **轨道倾角与朝向**（2026-10-29）：每个点一个不同的轨道平面，
            // 否则所有点都在 xy 平面里转，从侧面看就是一条扁线。
            oi: (hash01(sm.id + 'i') - 0.5) * 1.5,
            oh: hash01(sm.id + 'h') * 6.283,
            x: sp2.x, y: sp2.y, z: sp2.z || 0,
          };
        }
        animRef.current = seedAnim;
      }

      function collect(id) {
        return function (el) {
          if (el) elMap.current[id] = el; else delete elMap.current[id];
        };
      }

      function onDown(ev) {
        if (ev.button !== undefined && ev.button !== 0) return;
        // 原生选区会与旋转争抢拖拽；只禁用画布默认动作，详情仍可复制。
        if (ev.preventDefault) ev.preventDefault();
        dragRef.current = { on: true, x: ev.clientX, y: ev.clientY, moved: 0 };
      }
      function onMove(ev) {
        var d = dragRef.current;
        if (!d.on) return;
        var dx = ev.clientX - d.x; var dy = ev.clientY - d.y;
        d.moved += Math.abs(dx) + Math.abs(dy);
        if (d.moved > 6 && ev.currentTarget) ev.currentTarget.setAttribute('data-dragging', '1');
        d.x = ev.clientX; d.y = ev.clientY;
        var r = rotRef.current;
        r.rotY += dx * 0.006;
        r.vel = clamp(dx * 0.0012, -0.05, 0.05);   // 拖拽给一个角速度
        r.rotX = clamp(r.rotX + dy * 0.004, -1.15, 1.15);
      }
      function onUp(ev) {
        dragRef.current.on = false;
        if (ev && ev.currentTarget) ev.currentTarget.removeAttribute('data-dragging');
      }   // 惯性交给 projectFrame 慢慢衰减
      function onWheel(ev) {
        if (ev.preventDefault) ev.preventDefault();
        var r = rotRef.current;
        r.zoom = clamp(r.zoom * (ev.deltaY > 0 ? 0.94 : 1.06), 0.5, 2.4);
      }
      function onReset() { rotRef.current = { rotY: 0, rotX: -0.30, zoom: 1.4 }; }
      function pick(node) {
        if (dragRef.current.moved > 6) return;
        setFocus(node);
        setPanelIn(false);
        if (typeof window !== 'undefined' && window.requestAnimationFrame) {
          window.requestAnimationFrame(function () { setPanelIn(true); });
        } else { setPanelIn(true); }
      }
      function exit() { setPanelIn(false); setFocus(null); }

      React.useEffect(function () {
        if (!focus) return undefined;
        function onKey(ev) { if (ev.key === 'Escape') exit(); }
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('keydown', onKey);
          return function () { window.removeEventListener('keydown', onKey); };
        }
        return undefined;
      }, [focus]);

      React.useEffect(function () {
        if (!data) return undefined;
        var running = true;
        var raf = 0;
        var last = 0;
        function tick(ts) {
          if (!running) return;
          raf = window.requestAnimationFrame(tick);
          if (ts - last < 32) return;          // 上限 30fps
          last = ts;
          try { projectFrame(); } catch (e) {
            // 只报一次：既不在控制台刷屏，也不让错误完全静默。
            // （静默的 try/catch 让「漏声明一个变量」这种错看起来像"动画没生效"，查了很久。）
            if (!window.__chgFrameErr) {
              window.__chgFrameErr = 1;
              if (typeof console !== 'undefined') console.error('[dsh-chain-shared] projectFrame failed:', e);
            }
          }
        }
        // **先同步投影一次**：rAF 在后台标签页会被节流甚至完全暂停，
        // 只靠循环的话首帧可能停在初始化坐标（全挤在中心）。先算一帧兜底。
        if (layoutRef.current) {
          try { projectFrame(); } catch (e) {
            if (typeof console !== 'undefined') console.error('[dsh-chain-shared] first frame failed:', e);
          }
        }
        raf = window.requestAnimationFrame(tick);
        return function () { running = false; window.cancelAnimationFrame(raf); };
      }, [data]);

      if (error) return h('div', { className: 'chg-root' }, h('div', { className: 'chg-empty' }, '读取失败：' + error));
      // **2026-11-05：黑屏那 2 秒**。原来只写「读取中…」，路人等到第 3 秒就认定这个 tab 卡了。
      // 现在给形状：中心一个点先亮，然后一圈点自己长出来 —— 数据没到也先有"它正在成型"的感觉。
      if (!data) {
        var bootDots = [];
        for (var bi = 0; bi < 12; bi += 1) {
          var bang = (bi / 12) * Math.PI * 2;
          bootDots.push(h('circle', {
            key: 'bd' + bi,
            cx: 60 + Math.cos(bang) * 26,
            cy: 60 + Math.sin(bang) * 26,
            r: 2.2,
            fill: '#9fc4ff',
            className: 'chg-boot-dot',
            style: { animationDelay: (bi * 0.06) + 's' },
          }));
        }
        return h('div', { className: 'chg-root' },
          h('div', { className: 'chg-empty chg-boot' },
            h('svg', { viewBox: '0 0 120 120', width: '132', height: '132', 'aria-hidden': true },
              h('circle', { cx: 60, cy: 60, r: 3.4, fill: '#dce9ff', className: 'chg-boot-core' }),
              bootDots),
            h('div', { style: { marginTop: '4px', fontSize: '12px', letterSpacing: '1px', color: 'rgba(196,214,240,.7)' } }, '正在成型')));
      }
      var laid = layoutRef.current;
      if (!laid) return h('div', { className: 'chg-root' }, h('div', { className: 'chg-empty' }, '布局中…'));

      var cx = size.w / 2;
      var cy = size.h / 2;
      // **2026-10-29：0.42 → 0.47**（用户：排得开一点点，但别太远）。
      // 依据：R 是 min(宽,高) 算的，而这台机器上画布是"横长竖矮"（约 1500×790），
      // 高度一侧早就顶满了，横向还空着一大半。所以只能小幅上调，不能按宽度算
      // （按宽度算高方向会溢出画布）。
      var R = Math.min(size.w, size.h) * 0.46;

      /* ---- 真 3D 投影：每帧算，直接写 DOM（React 不重渲染）---- */
      function projectFrame() {
        var r = rotRef.current;
        var tt = frameNo.current / 30;                 // 秒
        // **开场铺开**：0→1 缓动（easeOutCubic）。所有位置/半径/亮度都乘它，
        // 于是星云从中心向外长出来，而不是一上来就满屏。
        var op = openRef.current;
        if (op.p < 1) op.p = Math.min(1, op.p + 0.018);
        var openE = 1 - Math.pow(1 - op.p, 3);
        // 自转：sin 缓动（0.6~1.0 倍速）+ 松手惯性衰减，转起来不"硬"
        if (spinRef.current) {
          var ease = 0.65 + 0.35 * Math.sin(tt * 0.23);
          if (!dragRef.current.on) r.rotY += 0.0007 * ease;
        }
        if (Math.abs(r.vel) > 1e-5) {
          r.rotY += r.vel;
          r.vel *= 0.94;                               // 惯性每秒衰减
        }
        var cY = Math.cos(r.rotY); var sY = Math.sin(r.rotY);
        var cX = Math.cos(r.rotX); var sX = Math.sin(r.rotX);
        var map = elMap.current;
        // ⚠️ 2026-10-28 第二次漏声明：AN 少了这一行 → 每帧 ReferenceError →
        // 所有点停在初始化坐标（画布中心），屏幕上看只剩一团雾。**同一个坑连踩两次。**
        var AN = animRef.current;
        frameNo.current += 1;
        // **发消息 → 滑进决策区**：没有真事件可听，就用节拍器模拟一次"被想起"。
        // 用户的要求是"只做视觉效果，不影响运行"，所以这里绝不写盘、不动数据。
        // **没有真事件就不演**（2026-10-30 用户点掉的那条：静默乱跳 = 装出来的）。
        // 动线只在用户按「演练」、或数据真变了的时候跑（见下面的 triggerFlow）。
        var flc = flowRef.current;
        if (flc.ids.length > 0 && tt - flc.t0 > 4.2) flc.ids = [];
        var doEvi = (frameNo.current % 3) === 0;

        // **七个池心各自公转**（大节点不是一个整体）。
        // ⚠️ 2026-10-28 踩过：这段曾经漏插，而下面的代码已经引用 poolNow ——
        // 于是 projectFrame 每帧抛 ReferenceError，被 tick 里的 try/catch 吞掉，
        // 表现是"节点全冻在中心、也不报错"。**加了 try/catch 的地方必须有别的观测手段。**
        var poolNow = {};
        for (var pn = 0; pn < laid.pools.length; pn += 1) {
          var ppn = laid.pools[pn];
          var pAng = ppn.a0 + tt * ppn.rate;
          poolNow[ppn.key] = {
            x: Math.cos(pAng) * ppn.r0,
            y: Math.sin(pAng) * ppn.r0,
            z: ppn.cz || 0,
            spin: tt * ppn.spin + ppn.ph,
          };
        }

        function put(id, x, y, z) {
          var x2 = x * cY + z * sY;
          var z2 = -x * sY + z * cY;
          var y3 = y * cX - z2 * sX;
          var z3 = y * sX + z2 * cX;
          var k = FOCAL / (FOCAL + z3);
          // **从 0 铺开**：所有坐标乘开场进度，星云从中心长出来。
          return { sx: cx + x2 * R * k * r.zoom * openE, sy: cy + y3 * R * k * r.zoom * openE, k: k };
        }
        var shownById = {};   // 本帧"显示坐标"，给线段复用（保证线和点严格同步）
        // 区域属于已有决策功能；边界不代表新增记忆，只有真实 pulse 使其激活。
        var decidePoint = put('decision-area', ZONES.decide.x, ZONES.decide.y, ZONES.decide.z);
        var metaPoint = put('meta-area', ZONES.meta.x, ZONES.meta.y, ZONES.meta.z);
        var areaRadius = 23 * r.zoom * decidePoint.k;
        var areaEl = map['decision:area'];
        if (areaEl) {
          areaEl.setAttribute('cx', decidePoint.sx.toFixed(1)); areaEl.setAttribute('cy', decidePoint.sy.toFixed(1));
          areaEl.setAttribute('rx', areaRadius.toFixed(1)); areaEl.setAttribute('ry', (areaRadius * 0.68).toFixed(1));
          areaEl.setAttribute('opacity', flowRef.current.ids.length ? '0.8' : '0.28');
        }
        var conduit = map['decision:conduit'];
        if (conduit) conduit.setAttribute('d', 'M' + decidePoint.sx + ' ' + decidePoint.sy
          + ' Q' + (Math.max(decidePoint.sx, metaPoint.sx) + 35 * r.zoom) + ' ' + ((decidePoint.sy + metaPoint.sy) / 2)
          + ' ' + metaPoint.sx + ' ' + metaPoint.sy);
        var sensePoint = put('sense', ZONES.sense.x, ZONES.sense.y, ZONES.sense.z);
        if (map['sense:latest']) {
          map['sense:latest'].setAttribute('transform', 'translate(' + clamp(sensePoint.sx, 108, size.w - 108).toFixed(1) + ' ' + clamp(sensePoint.sy - 18, 8, size.h - 142).toFixed(1) + ')');
        }

        // 边缘光跟随球（只描边）：投到原点，半径按投影缩放
        var rimp = put('rim', 0, 0, 0);
        var rimEdge = map['rim:edge']; var rimGlow = map['rim:glow'];
        var rimR = SPHERE_R_DRAW * R * rimp.k * r.zoom * openE;
        if (rimEdge) {
          rimEdge.setAttribute('cx', rimp.sx.toFixed(1));
          rimEdge.setAttribute('cy', rimp.sy.toFixed(1));
          rimEdge.setAttribute('r', rimR.toFixed(1));
        }
        if (rimGlow) {
          rimGlow.setAttribute('cx', rimp.sx.toFixed(1));
          rimGlow.setAttribute('cy', rimp.sy.toFixed(1));
          rimGlow.setAttribute('r', (rimR * 1.03).toFixed(1));
        }

        // **提炼阶段**：动线 1.6–3.2s 时，在元记忆区点亮橙色小点（带"被想起 N 次"）
        var flM = flowRef.current;
        var phaseT = tt - flM.t0;
        var metaOn = flM.ids.length > 0 && phaseT >= 1.6;
        var mpo = put('metaDot', ZONES.meta.x, ZONES.meta.y, ZONES.meta.z);
        for (var mdi = 0; mdi < 3; mdi += 1) {
          var mg = map['metaDot:' + mdi];
          if (!mg) continue;
          var sourceNode = laid.mem.find(function (n) { return n.id === flM.ids[mdi]; });
          var showThis = metaOn && phaseT >= 1.6 + mdi * 0.15 && sourceNode && Number(sourceNode.recalled) >= 1;
          mg.setAttribute('opacity', showThis ? '1' : '0');
          if (!showThis) continue;
          var off = (mdi - (Math.min(3, flM.ids.length) - 1) / 2) * 13;
          // 橙点从决策区移动到元记忆区，位置与真实种子绑定。
          var decisionPoint = put('extract', ZONES.decide.x, ZONES.decide.y, ZONES.decide.z);
          var extraction = Math.min(1, Math.max(0, (phaseT - 1.6 - mdi * 0.15) / 0.6));
          var curveX = Math.max(decisionPoint.sx, mpo.sx) + 35 * r.zoom;
          var curveY = (decisionPoint.sy + mpo.sy) / 2;
          var inv = 1 - extraction;
          var mx = inv * inv * decisionPoint.sx + 2 * inv * extraction * curveX + extraction * extraction * mpo.sx + off * Math.sin(Math.PI * extraction);
          var my = inv * inv * decisionPoint.sy + 2 * inv * extraction * curveY + extraction * extraction * mpo.sy;
          var mc = mg.firstChild; var mh = mg.childNodes[1]; var mt = mg.childNodes[2];
          if (mc) { mc.setAttribute('cx', mx.toFixed(1)); mc.setAttribute('cy', my.toFixed(1)); }
          if (mh) { mh.setAttribute('cx', mx.toFixed(1)); mh.setAttribute('cy', my.toFixed(1)); }
          if (mt) {
            mt.setAttribute('x', (mx + 6).toFixed(1));
            mt.setAttribute('y', (my + 3).toFixed(1));
            // 标签用真实数据：这条记忆被想起过几次（metaFacts 口径，图数据里带着）
            var mid = flM.ids[mdi];
            var mn2 = null;
            for (var q2 = 0; q2 < laid.mem.length; q2 += 1) {
              if (String(laid.mem[q2].id) === String(mid)) { mn2 = laid.mem[q2]; break; }
            }
            mt.textContent = mn2 && mn2.recalled
              ? ('被想起 ' + mn2.recalled + ' 次')
              : '刚被想起';
          }
        }

        for (var i = 0; i < laid.mem.length; i += 1) {
          var n = laid.mem[i];
          var p = laid.pos[n.id];
          var el = map[n.id];
          if (!p || !el) continue;
          var pnw = poolNow[p.key] || { x: 0, y: 0, z: 0, spin: 0 };
          var a2 = AN ? AN[n.id] : null;
          var an = (hash01(n.id + 'ph') * 6.283);
          if (a2) {
            // **行星轨道**（2026-10-29 改）：每个点绕池心走自己的圆轨道 ——
            // 半径固定、角速度按 id 固定、轨道压扁一点（椭圆感）。
            // 原来这里是"弹簧追一个带随机晃动的目标"，追的过程看起来就是在飘。
            var oAng = (a2.oa || 0) + tt * (a2.ow || 0.2);
            var oR = a2.orr || Math.sqrt((a2.ox || 0) * (a2.ox || 0) + (a2.oy || 0) * (a2.oy || 0));
            var oF = a2.of || 0.8;
            // 先在轨道平面里算出点，再按各自的倾角/朝向转到三维空间 ——
            // 这样每条轨道朝向不同，侧面看才有厚度。
            var opx = Math.cos(oAng) * oR;
            var opy = Math.sin(oAng) * oR * oF;
            var oi2 = a2.oi || 0;
            var oh2 = a2.oh || 0;
            var ci = Math.cos(oi2); var si = Math.sin(oi2);
            var ch = Math.cos(oh2); var sh = Math.sin(oh2);
            var py1 = opy * ci;                 // 绕 x 轴倾斜
            var pz1 = opy * si;
            var tx = pnw.x + opx * ch + pz1 * sh;
            var ty = pnw.y + py1;
            var tz = (pnw.z || 0) + (a2.oz || 0) + (-opx * sh + pz1 * ch);
            // **纯视觉动线**（2026-10-30 用户定）：被"想起"的节点滑进决策区，停一下，
            // 再往元记忆区飘一段，然后自己回轨道 —— **只改位置，不碰任何数据**。
            // 时间轴：0–1.6s 去决策区；1.6–3.2s 去元记忆区；之后回原轨道。
            var fl2 = flowRef.current;
            if (fl2.ids.indexOf(n.id) >= 0) {
              var fps = tt - fl2.t0;
              if (fps < 1.6) { tx = ZONES.decide.x; ty = ZONES.decide.y; tz = ZONES.decide.z; }
              else if (fps < 3.2) { tx = ZONES.meta.x; ty = ZONES.meta.y; tz = ZONES.meta.z; }
            }
            // **弹簧跟随**：有延迟、有惯性 —— 这就是"跟随感"
            // 静默采用冻结位置，避免轨道运动破坏点球；只有真实种子往返。
            tx = p.x; ty = p.y; tz = p.z || 0;
            var pulseIndex = fl2.ids.indexOf(n.id);
            if (pulseIndex >= 0) {
              var elapsed = tt - fl2.t0 - pulseIndex * 0.15;
              var mix = elapsed < 0 ? 0 : elapsed < 1.2 ? 1 - Math.pow(1 - elapsed / 1.2, 3)
                : elapsed < 1.6 ? 1 : elapsed < 2.4 ? Math.pow(1 - (elapsed - 1.6) / 0.8, 3) : 0;
              tx += (ZONES.decide.x - p.x) * mix;
              ty += (ZONES.decide.y - p.y) * mix;
              tz += (ZONES.decide.z - (p.z || 0)) * mix;
            }
            a2.x = tx; a2.y = ty; a2.z = tz;
          }
          var curX = a2 ? a2.x : p.x;
          var curY = a2 ? a2.y : p.y;
          var curZ = a2 ? a2.z : (p.z || 0);
          shownById[n.id] = [curX, curY, curZ];
          var o = put(n.id, curX, curY, curZ);
          var w = clamp(Number(n.weight) || 0.5, 0.1, 1);
          // **每个点自己的相位**：整齐地一起明灭反而更假，散开才像活的
          var ph = (hash01(n.id) * 6.283) + (hash01(n.id + 'p') * 3.1);
          // **静默要真的静**（2026-10-30 用户原话：静默状态节点乱跳，像故意装出来的）
          // 呼吸 0.12 → 0.025，闪烁 0.28 → 0.06，漂移 0.5px → 0.10px。
          var breathe = 1;
          var twinkle = 1;
          // 极缓慢的原地漂移（±1px），让静止时也不"死"
          var driftX = Math.sin(tt * 0.55 + ph) * 0.10;
          var driftY = Math.cos(tt * 0.43 + ph * 1.3) * 0.10;
          // 出生进度：新加入的点从 0 长出来（0.6 秒 = 约 18 帧）
          var born = 1;
          if (a2 && a2.b !== undefined && a2.b < 1) {
            a2.b = Math.min(1, a2.b + 0.055);
            born = a2.b;
          }
          // 点画大一点：只有 200 来条真实记忆，太小凑不出球的形（只是画大，不是造假）
          var rad = (1.05 + 1.45 * w) * o.k * breathe * (0.30 + 0.70 * openE) * born;
          var sx2 = o.sx + driftX;
          var sy2 = o.sy + driftY;
          if (el.dot) {
            el.dot.setAttribute('cx', sx2.toFixed(1));
            el.dot.setAttribute('cy', sy2.toFixed(1));
            el.dot.setAttribute('r', Math.max(0.5, rad).toFixed(2));
            el.dot.setAttribute('opacity', (clamp((0.30 + 0.70 * o.k) * twinkle, 0.12, 1) * born).toFixed(3));
          }
          if (el.halo) {
            el.halo.setAttribute('cx', sx2.toFixed(1));
            el.halo.setAttribute('cy', sy2.toFixed(1));
            el.halo.setAttribute('r', Math.max(2, rad * 3.8).toFixed(2));
            el.halo.setAttribute('opacity', clamp(0.12 + 0.08 * o.k, 0.10, 0.24).toFixed(3));
          }
          if (el.txt) {
            el.txt.setAttribute('x', (o.sx + rad + 4).toFixed(1));
            el.txt.setAttribute('y', (o.sy + 3.2).toFixed(1));
            el.txt.setAttribute('opacity', '1');
          }
        }

        for (var j = 0; j < laid.pools.length; j += 1) {
          var pc = laid.pools[j];
          var pp = laid.pos['pool:' + pc.key];
          var pel = map['pool:' + pc.key];
          if (!pp || !pel) continue;
          var pnow = poolNow[pc.key];
          var po = put('p', pnow ? pnow.x : pp.cx, pnow ? pnow.y : pp.cy, pnow ? pnow.z : 0);
          var ppulse = 1;
          if (pel.dot) {
            pel.dot.setAttribute('cx', po.sx.toFixed(1));
            pel.dot.setAttribute('cy', po.sy.toFixed(1));
            // 决策以区域接收记忆，元记忆仍保留汇入的大节点。
            pel.dot.setAttribute('r', (pc.key === 'decision' ? 0 : pc.key === 'meta' ? 4 : 2.2 * ppulse).toFixed(2));
          }
          // 团跟着池心平移（一次 transform，8 个池 = 8 次写）
          var clEl = map['cluster:' + pc.key];
          if (clEl) clEl.setAttribute('transform', 'translate(' + po.sx.toFixed(1) + ',' + po.sy.toFixed(1) + ')');
          if (pel.halo) {
            pel.halo.setAttribute('cx', po.sx.toFixed(1));
            pel.halo.setAttribute('cy', po.sy.toFixed(1));
            pel.halo.setAttribute('r', (12 * ppulse * openE).toFixed(1));
          }
          // **底雾跟着转**：原来它只在初始化算了一次，整个背景是死的（这是"硬"的主因）
          var fel = map['fog:' + pc.key];
          if (fel) {
            fel.setAttribute('cx', po.sx.toFixed(1));
            fel.setAttribute('cy', po.sy.toFixed(1));
            fel.setAttribute('r', Math.max(6, R * (0.05 + 0.010 * Math.sqrt(pc.count)) * (0.92 + 0.08 * po.k) * openE).toFixed(1));
            fel.setAttribute('opacity', (clamp(0.55 + 0.45 * po.k, 0.3, 1) * (0.25 + 0.75 * openE)).toFixed(3));
          }
          if (pel.txt) { pel.txt.setAttribute('x', (po.sx + 9).toFixed(1)); pel.txt.setAttribute('y', (po.sy - 6).toFixed(1)); }
        }

        for (var l = 0; l < laid.linkPairs.length; l += 1) {
          var pair = laid.linkPairs[l];
          var lel = map['ln:' + pair[0] + '>' + pair[1]];
          // **端点直接取节点本帧的显示坐标**（含弹簧跟随与开场插值）——
          // 再也不自己算一遍，线就不可能和点脱开。
          var sa = shownById[pair[0]]; var sb = shownById[pair[1]];
          if (!sa || !sb || !lel) continue;
          // 调用期间断线，归位后恢复；按每个种子的错开时间判断，避免提前重连。
          var activeFlow = flowRef.current;
          var detached = pair.some(function (id) {
            var index = activeFlow.ids.indexOf(id);
            var elapsed = tt - activeFlow.t0 - index * 0.15;
            return index >= 0 && elapsed >= 0 && elapsed < 2.4;
          });
          if (detached) {
            lel.setAttribute('opacity', '0');
            continue;
          }
          var oa = put('a', sa[0], sa[1], sa[2]);
          var ob = put('b', sb[0], sb[1], sb[2]);
          // **微弯弧线**：直线穿网太生硬，弦中点沿法线偏一点就柔了。
          // 偏的方向由 id 决定（同一对永远往同一边弯，不会每帧抖）。
          var dxL = ob.sx - oa.sx; var dyL = ob.sy - oa.sy;
          var len = Math.sqrt(dxL * dxL + dyL * dyL) || 1;
          var bowSign = (hash01(pair[0] + pair[1]) - 0.5) * 2;
          var bow = Math.min(18, len * 0.10) * bowSign;
          var mxL = (oa.sx + ob.sx) / 2 - (dyL / len) * bow;
          var myL = (oa.sy + ob.sy) / 2 + (dxL / len) * bow;
          lel.setAttribute('d',
            'M' + oa.sx.toFixed(1) + ' ' + oa.sy.toFixed(1)
            + 'Q' + mxL.toFixed(1) + ' ' + myL.toFixed(1)
            + ' ' + ob.sx.toFixed(1) + ' ' + ob.sy.toFixed(1));
          if (laid.pos[pair[0]].key !== 'hippocampus' && laid.pos[pair[1]].key !== 'hippocampus') {
            // 在三维球面上走两端之间的短弧，再投影；两端必须仍是原节点。
            // 背面弧线投到球内部是正常遮挡关系，不能因此移走端点到轮廓圈。
            var points = relationArc(sa, sb);
            var path = '';
            for (var ai = 0; ai < points.length; ai += 1) {
              var ap = put('arc', points[ai][0], points[ai][1], points[ai][2]);
              path += (ai === 0 ? 'M' : 'L') + ap.sx.toFixed(2) + ' ' + ap.sy.toFixed(2);
            }
            lel.setAttribute('d', path);
          }
          // 淡：越远越淡；再乘开场进度
          lel.setAttribute('opacity',
            (clamp(0.035 + 0.105 * ((oa.k + ob.k) / 2), 0.02, 0.17) * openE).toFixed(3));
        }

        if (doEvi) {
          for (var q = 0; q < laid.evi.length; q += 1) {
            var en = laid.evi[q];
            var ep = laid.pos[en.id];
            var eel = map[en.id];
            if (!ep || !eel) continue;
            // **跟着父节点本帧的位置走**（2026-10-29）：父点现在绕轨道转，
            // 证据点如果还用布局时的死坐标，就会脱离父点飘在外面。
            var par = shownById[en.parent];
            var ex2 = ep.x;
            var ey2 = ep.y;
            var ez2 = ep.z || 0;
            if (par) {
              var pl = laid.pos[en.parent];
              ex2 = par[0] + (ep.x - pl.x);
              ey2 = par[1] + (ep.y - pl.y);
              ez2 = par[2] + ((ep.z || 0) - (pl.z || 0));
            }
            var eo = put('e', ex2, ey2, ez2);
            eel.setAttribute('cx', eo.sx.toFixed(1));
            eel.setAttribute('cy', eo.sy.toFixed(1));
            eel.setAttribute('opacity', (clamp(0.03 + 0.13 * eo.k, 0.02, 0.2) * openE).toFixed(3));
          }
        }
      }

      /* ---- 标签只给权重前 10 ---- */
      var topIds = {};
      (function () {
        var arr = laid.mem.slice().sort(function (a, b) { return (Number(b.weight) || 0) - (Number(a.weight) || 0); });
        for (var ti = 0; ti < Math.min(10, arr.length); ti += 1) topIds[arr[ti].id] = 1;
      })();

      /* ---- 相关边（跨池的桥）---- */
      var linkEls = [];
      var linkPairs = [];
      var hippoIds = {};
      for (var hz = 0; hz < laid.mem.length; hz += 1) {
        if (laid.mem[hz].pool === 'hippocampus') hippoIds[laid.mem[hz].id] = 1;
      }
      var seen = {};
      var links = data.links || [];
      // 注意：这里**遍历所有边**，是不是要画交给里面的 isChain / showLines 判断 ——
      // 之前把开关写在循环上界，结果结构链（chain）也一起被关掉了（2026-10-30 截图实测 paths=0）。
      for (var lk = 0; lk < links.length; lk += 1) {
        var L = links[lk];
        // 元记忆是提炼结果，不参与关系网；两端任一为元记忆都跳过。
        if (L.kind === 'meta' || (laid.pos[L.source] && laid.pos[L.source].key === 'meta')
          || (laid.pos[L.target] && laid.pos[L.target].key === 'meta')) continue;
        // chain = 海马体内部的结构链：它不是"想起了谁"，是这个区自己的形状 → 始终画
        var isChain = L.kind === 'chain';
        if (!isChain) {
          if (L.kind !== 'related') continue;
          if (!showLines) continue;
        }
        // **海马体不连线**（2026-10-30 用户定）：它只是原料 —— 连上去会让人以为它参与了联想。
        // 海马体**内部连线保留**（2026-10-30 用户改的）：原料之间也有先后/同源关系；
        // 只切断跨池那部分 —— 它不参与联想网。
        var hs = !!hippoIds[L.source]; var ht = !!hippoIds[L.target];
        if (hs !== ht) continue;
        if (!laid.pos[L.source] || !laid.pos[L.target]) continue;
        var key = L.source + '>' + L.target;
        if (seen[key]) continue;
        seen[key] = 1;
        linkPairs.push([L.source, L.target]);
        // 注意：这里必须是 <path>（不是 <line>）。更新循环写的是 `d`；
        // 用 <line> 的话 setAttribute('d') 完全无效，线会停在初始的 0,0 —— 看起来"线是死的"。
        linkEls.push(h('path', {
          key: 'ln-' + key, 'data-chg-link': laid.pos[L.source].key + ' ' + laid.pos[L.target].key,
          ref: collect('ln:' + key),
          d: 'M0 0',
          fill: 'none',
          stroke: '#9dc2f0',
          strokeWidth: 0.45,
          strokeLinecap: 'round',
          opacity: 0.06,
        }));
      }
      // **海马体内部链**（2026-10-30）：原料按时序入场，彼此有先后 —— 连成一条淡链。
      // 为什么在客户端算：它只是"同一个池里相邻两条"，不是联想边；
      // 放前端就不必等宿主重启，刷新即可见。
      try {
        var hippoNodes = laid.mem.filter(function (m3) { return m3.pool === 'hippocampus'; });
        hippoNodes.sort(function (a4, b4) { return String(a4.id) < String(b4.id) ? -1 : 1; });
        for (var hci = 1; hci < hippoNodes.length; hci += 1) {
          var ha = String(hippoNodes[hci - 1].id);
          var hb = String(hippoNodes[hci].id);
          var hkey = ha + '>' + hb;
          if (seen[hkey]) continue;
          seen[hkey] = 1;
          linkPairs.push([ha, hb]);
          linkEls.push(h('path', {
            key: 'ln-' + hkey, 'data-chg-link': 'hippocampus',
            ref: collect('ln:' + hkey),
            d: 'M0 0',
            fill: 'none',
            stroke: '#f2f7ff',
            strokeWidth: 0.5,
            strokeLinecap: 'round',
            opacity: 0.12,
          }));
        }
      } catch {
        /* 连不上就只画点 */
      }

      laid.linkPairs = linkPairs;

      /* ---- 底雾（径向渐变，不用 filter）---- */
      // **中央球**（2026-10-30 星链）：主体是一个球 —— 记忆点是绕着它转的卫星。
      // 用三层径向渐变做立体感：内核亮 → 中层偏暗 → 外圈光晕（大气层）。
      var sphereGrad = h('radialGradient', {
        key: 'sphere-grad',
        id: 'chg-sphere',
        cx: '34%', cy: '30%', r: '72%',
      },
      h('stop', { offset: '0%', stopColor: '#8fd0ff', stopOpacity: '0.42' }),
      h('stop', { offset: '38%', stopColor: '#2f6bb0', stopOpacity: '0.22' }),
      h('stop', { offset: '78%', stopColor: '#12203a', stopOpacity: '0.85' }),
      h('stop', { offset: '100%', stopColor: '#070c16', stopOpacity: '0.95' }));
      var sphereAtmo = h('radialGradient', { key: 'sphere-atmo', id: 'chg-sphere-atmo' },
        h('stop', { offset: '62%', stopColor: '#7fc4ff', stopOpacity: '0' }),
        h('stop', { offset: '88%', stopColor: '#7fc4ff', stopOpacity: '0.10' }),
        h('stop', { offset: '100%', stopColor: '#7fc4ff', stopOpacity: '0' }));

      var defs = h('defs', null, [sphereAtmo, sphereGrad], POOL_SPEC.map(function (p) {
        return [h('radialGradient', { key: 'glow-' + p.key, id: 'chg-glow-' + p.key },
          // 渐变柔光避免叠圆出现硬边；仍不使用 SVG filter。
          h('stop', { offset: '0%', stopColor: '#ffffff', stopOpacity: '0.9' }),
          h('stop', { offset: '28%', stopColor: p.color, stopOpacity: '0.65' }),
          h('stop', { offset: '100%', stopColor: p.color, stopOpacity: '0' })),
        h('radialGradient', { key: 'bead-' + p.key, id: 'chg-bead-' + p.key, cx: '32%', cy: '28%', r: '75%' },
          // 同一真实节点用偏心高光表示球感，无需滤镜或额外装饰粒子。
          h('stop', { offset: '0%', stopColor: '#ffffff' }),
          h('stop', { offset: '35%', stopColor: '#fff8ed' }),
          h('stop', { offset: '62%', stopColor: p.color }),
          h('stop', { offset: '100%', stopColor: p.color, stopOpacity: '0.85' })),
        h('radialGradient', { key: 'rg-' + p.key, id: 'chg-fog-' + p.key },
          h('stop', { offset: '0%', stopColor: p.color, stopOpacity: '0.17' }),
          h('stop', { offset: '45%', stopColor: p.color, stopOpacity: '0.07' }),
          h('stop', { offset: '100%', stopColor: p.color, stopOpacity: '0' }))];
      }));
      var fogEls = laid.pools.map(function (p) {
        return h('circle', {
          key: 'fog-' + p.key, className: 'chg-pool-ambient', 'data-chg-pool': p.key,
          ref: collect('fog:' + p.key),
          cx: cx + p.cx * R, cy: cy + p.cy * R,
          r: Math.max(110, R * (0.40 + 0.05 * Math.sqrt(p.count))),
          fill: 'url(#chg-fog-' + p.key + ')', opacity: 0.85,
        });
      });

      /* ---- 中央球本体（每帧跟着投影缩放）---- */
      var sphereEls = [
        h('circle', { key: 'sphere-atmo', ref: collect('sphere:atmo'), cx: cx, cy: cy, r: R * 0.46, fill: 'url(#chg-sphere-atmo)', opacity: 0.9 }),
        h('circle', { key: 'sphere', ref: collect('sphere:body'), cx: cx, cy: cy, r: R * 0.40, fill: 'url(#chg-sphere)', opacity: 0.96 }),
      ];

      /* ---- 球的边缘光（只描边、不填充 —— 用户说过球体本身不要渲染）----
       * 参考图里球的外圈有一道暖光，那是"球在哪"的唯一暗示；靠点自己围出来的话，
       * 199 个点还不足以让人看出轮廓。
       */
      var rimEls = [
        h('circle', { key: 'rim-glow', ref: collect('rim:glow'), cx: cx, cy: cy, r: R * 0.44,
          fill: 'none', stroke: '#ffb066', strokeOpacity: 0.16, strokeWidth: 7 }),
        h('circle', { key: 'rim', ref: collect('rim:edge'), cx: cx, cy: cy, r: R * 0.40,
          fill: 'none', stroke: '#ffc78a', strokeOpacity: 0.34, strokeWidth: 1.6 }),
      ];

      /* ---- 元记忆"提炼"用的橙色小点（动线第 2 阶段才出现）----
       * 它是从决策区提炼出来的**结果**，不是一开始就挂在那儿的装饰。
       */
      var metaDotEls = [];
      for (var md = 0; md < 3; md += 1) {
          metaDotEls.push(h('g', { key: 'meta-dot-' + md, 'data-chg-pool': 'meta', ref: collect('metaDot:' + md), opacity: 0,
            style: { cursor: 'pointer' }, onClick: (function (index) { return function () {
              var id = flowRef.current.ids[index];
              var n = layoutRef.current.mem.find(function (item) { return item.id === id; });
              if (n) pick(Object.assign({}, n, { pool: 'meta', kind: 'meta', label: '被想起 ' + Number(n.recalled) + ' 次', conclusion: n.label }));
            }; })(md) },
          h('circle', { 'data-role': 'meta-dot', cx: 0, cy: 0, r: 2.6, fill: '#ffa64d', opacity: 0.95 }),
          h('circle', { 'data-role': 'meta-halo', cx: 0, cy: 0, r: 9, fill: '#ffa64d', opacity: 0.16 }),
          h('text', { 'data-role': 'meta-txt', className: 'chg-tip', x: 6, y: 3,
            style: { paintOrder: 'stroke', stroke: 'rgba(4,6,10,.85)', strokeWidth: 2.2 } }, '')));
      }

      /* ---- 依据微粒 ---- */
      var eviEls = laid.evi.map(function (en) {
        return h('circle', {
          key: 'ev-' + en.id, 'data-role': 'evi', ref: collect(en.id),
          className: 'chg-pool-ambient', 'data-chg-pool': en.pool || 'dailyPartial',
          cx: cx, cy: cy, r: 0.7, fill: poolColor(en.pool), opacity: 0.07,
        });
      });

      /* ---- 记忆球 ---- */
      var nodeEls = laid.mem.map(function (mn) {
        var col = poolColor(mn.pool);
        return h('g', {
          key: 'n-' + mn.id,
          className: 'chg-item', 'data-chg-pool': mn.pool || 'dailyPartial',
          onClick: function () { pick(mn); },
        },
        h('circle', { 'data-role': 'halo', ref: function (el) { if (!elMap.current[mn.id]) elMap.current[mn.id] = {}; elMap.current[mn.id].halo = el; }, cx: cx, cy: cy, r: 2, fill: 'url(#chg-glow-' + (mn.pool || 'dailyPartial') + ')', opacity: 0.2 }),
        h('circle', { 'data-role': 'mem', ref: function (el) { if (!elMap.current[mn.id]) elMap.current[mn.id] = {}; elMap.current[mn.id].dot = el; }, cx: cx, cy: cy, r: 1.4, fill: 'url(#chg-bead-' + (mn.pool || 'dailyPartial') + ')', opacity: 0.9 }),
        labels && topIds[mn.id]
          ? h('text', {
            ref: function (el) { if (!elMap.current[mn.id]) elMap.current[mn.id] = {}; elMap.current[mn.id].txt = el; },
            className: 'chg-tip', x: cx, y: cy,
            style: { paintOrder: 'stroke', stroke: '#070b13', strokeWidth: 4 },
          }, String(mn.label || '').slice(0, 14) + (String(mn.label || '').length > 14 ? '…' : ''))
          : null);
      });

      /* ---- 池"团"：每个池是一团粒子，不是一个圆点 ----
       *
       * 2026-10-30 用户点破的：**"你做的是大节点，不是团"** —— 之前池心就是一颗大圆点，
       * 看着像"八个球挂在那儿"，不像星云。真正像团的做法是：一团几百颗小粒子
       * （斐波那契球面撒点、颜色是池色、靠中心更密），中心只留一团柔光。
       *
       * 性能：每池 64 颗，8 池 = 512 颗，位置在创建时算一次，
       * 每帧只对每个 <g> 做一次 translate —— 8 次 setAttribute，不拖帧。
       */
      var CLUSTER_N = 64;
      var clusterEls = laid.pools.map(function (p) {
        var col = poolColor(p.key);
        var kids = [];
        for (var ci = 0; ci < CLUSTER_N; ci += 1) {
          // 球面均匀撒点（Fibonacci），半径 ∛ 递增 → 中心密、外圈稀，像真星团
          var uy = 1 - (ci + 0.5) * 2 / CLUSTER_N;
          var rxz = Math.sqrt(Math.max(0, 1 - uy * uy));
          var phi = ci * 2.39996323;
          var rr = Math.cbrt((ci + 1) / CLUSTER_N) * (R * 0.048);
          kids.push(h('circle', {
            key: 'c' + ci,
            cx: (Math.cos(phi) * rxz * rr).toFixed(1),
            cy: (uy * rr * 0.92).toFixed(1),
            r: (0.45 + hash01(p.key + 'cr' + ci) * 0.75).toFixed(2),
            fill: col,
            opacity: (0.16 + hash01(p.key + 'co' + ci) * 0.26).toFixed(2),
          }));
        }
        return h('g', {
          key: 'cl-' + p.key,
          className: 'chg-cluster', 'data-chg-pool': p.key,
          ref: collect('cluster:' + p.key),
          transform: 'translate(0,0)',
        }, kids);
      });

      /* ---- 池心（现在是"团里的柔光"，不是主角）---- */
      var poolEls = laid.pools.map(function (p) {
        var col = poolColor(p.key);
        return h('g', { key: 'pl-' + p.key, 'data-chg-pool': p.key },
          h('circle', { ref: function (el) { if (!elMap.current['pool:' + p.key]) elMap.current['pool:' + p.key] = {}; elMap.current['pool:' + p.key].halo = el; }, cx: cx, cy: cy, r: 12, fill: col, opacity: 0.09 }),
          h('circle', { 'data-role': 'pool', ref: function (el) { if (!elMap.current['pool:' + p.key]) elMap.current['pool:' + p.key] = {}; elMap.current['pool:' + p.key].dot = el; }, cx: cx, cy: cy, r: 2.8, fill: col, opacity: 0.95 }),
          labels
            ? h('text', {
              ref: function (el) { if (!elMap.current['pool:' + p.key]) elMap.current['pool:' + p.key] = {}; elMap.current['pool:' + p.key].txt = el; },
              className: 'chg-tip chg-tip-pool', x: cx, y: cy,
            }, poolLabel(p.key) + ' ' + p.count)
            : null);
      });

      /* ---- 微尘（静态，不参与投影）---- */
      var dustEls = [];
      var DN = Math.min(900, laid.mem.length * 8);
      for (var di = 0; di < DN; di += 1) {
        var host = laid.mem[di % laid.mem.length];
        var hp = laid.pos[host.id];
        var dxs = (hash01('dx' + di) - 0.5) * 0.10;
        var dys = (hash01('dy' + di) - 0.5) * 0.08;
        dustEls.push(h('circle', {
          key: 'd-' + di, className: 'chg-pool-ambient', 'data-chg-pool': host.pool || 'dailyPartial',
          cx: cx + (hp.x + dxs) * R, cy: cy + (hp.y + dys) * R,
          r: 0.35 + hash01('dr' + di) * 0.4,
          fill: poolColor(host.pool),
          opacity: 0.02 + hash01('da' + di) * 0.06,
        }));
      }

      /* ---- 聚焦层 ---- */
      var focusEl = null;
      if (focus) {
        var fcol = poolColor(focus.kind === 'mood' ? 'emotion' : focus.pool);
        focusEl = h('g', { key: 'focus' },
          h('circle', { cx: cx, cy: cy, r: 58, fill: fcol, opacity: 0.05 }),
          h('circle', { cx: cx, cy: cy, r: 30, fill: fcol, opacity: 0.10 }),
          h('circle', { cx: cx, cy: cy, r: 14, fill: fcol, opacity: 0.20 }),
          h('circle', { cx: cx, cy: cy, r: 7, fill: fcol, opacity: 0.95 }));
      }

      // **只有真事件才演**（2026-10-30 用户点掉的那条）：条数变了 = 有新记忆进来或退役，
      // 这时才让节点"滑进决策区 → 提炼 → 回轨道"。静默不动。
      var sig = String((data.stats && data.stats.total) || laid.mem.length) + '|' + String(laid.mem.length);
      if (lastSigRef.current === '') {
        lastSigRef.current = sig;          // 首次只记录，不演
      }

      var total = (data.stats && data.stats.total) ? data.stats.total : laid.mem.length;
      var TARGET_SESSION_LABEL = typeof data.targetSession === 'string' ? data.targetSession : '';
      var bar = h('div', { className: 'chg-bar' },
        // 2026-11-05：这是全画最有信息量的一行，原来和版本号同一个灰阶、几乎看不见。
        // 单独提出来加粗提亮，其余辅助信息保持淡。
        h('span', {
          className: 'chg-total',
          style: { fontSize: '13px', fontWeight: 600, color: 'rgba(236,244,255,.95)', letterSpacing: '.2px' },
        }, '共 ' + total + ' 条 · ' + laid.pools.length + ' 池 · ' + laid.mem.length + ' 点'),
        h('span', { className: 'chg-k', style: { fontSize: '10px', opacity: 0.5 } }, VERSION),
        h('span', { className: 'chg-k', style: { fontSize: '10px', opacity: 0.55 } }, TARGET_SESSION_LABEL ? '会话 ' + TARGET_SESSION_LABEL : '全会话共享'),
        // 夜巡：只读状态。用户之前"等了两分钟没动"，就是因为界面上根本没有这一项
        h('span', {
          className: 'chg-k',
          style: { fontSize: '10px', opacity: 0.55 },
          title: patrolState && patrolState.ok
            ? ('最近一次：' + patrolState.localTime + ' · ' + patrolState.trigger + ' · 报告 ' + Math.round((patrolState.reportBytes || 0) / 1024) + ' KB · 今天第 ' + patrolState.runs + ' 次')
            : '夜巡还没跑过（每天 18:00 后、或压缩后 90 秒自动跑）',
        }, patrolState && patrolState.ok
          ? ('夜巡 ' + patrolState.localTime + ' · ' + patrolState.total + ' 条')
          : '夜巡 未跑'),
        h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
          h('button', { className: 'chg-btn', 'data-on': labels ? '1' : '0', onClick: function () { setLabels(!labels); } }, '标签'),
          h('button', { className: 'chg-btn', onClick: onReset }, '复位'),
          h('button', {
            className: 'chg-btn',
            title: '手动放一次动线：节点滑进决策区 → 提炼成元记忆 → 回轨道（纯视觉）',
            onClick: function () {
              var fl2b = flowRef.current;
              return; // 状态指示不产生事件。
            },
          }, '真实事件驱动'),
          h('button', {
            className: 'chg-btn',
            'data-on': showLayers ? '1' : '0',
            title: '感知 / 决策 / 元记忆 —— 这三层现在各自看到了什么',
            onClick: function () { setShowLayers(!showLayers); },
          }, '三层'),
          h('button', {
            className: 'chg-btn',
            'data-on': showSettings ? '1' : '0',
            title: '记忆寿命 / 注入预算 / 夜巡时间',
            onClick: function () { setShowSettings(!showSettings); },
          }, '设置')));

      // 与顶部「点」同口径，只数画布中的记忆节点；池心、依据和装饰粒子不计数。
      var poolCounts = {};
      laid.mem.forEach(function (node) {
        var key = node.pool || 'dailyPartial';
        poolCounts[key] = (poolCounts[key] || 0) + 1;
      });
      var legend = h('aside', { className: 'chg-legend', 'aria-label': '记忆池图例',
        'data-collapsed': legendOpen ? '0' : '1' },
        h('button', { type: 'button', className: 'chg-legend-head',
          'aria-expanded': legendOpen,
          title: legendOpen ? '收起池图例' : '展开池图例' + (activePool ? ' · 正在高亮' + poolLabel(activePool) : ''),
          onClick: function () { setLegendOpen(function (open) { return !open; }); } },
          !legendOpen && activePool ? h('span', { className: 'chg-legend-swatch',
            style: { color: poolColor(activePool) }, 'aria-hidden': true }) : null,
          h('strong', null, legendOpen ? '池图例' : '图例'),
          legendOpen ? h('span', { className: 'chg-legend-meta' }, POOL_SPEC.length + ' 个池') : null,
          h('span', { className: 'chg-legend-chevron', 'aria-hidden': true }, legendOpen ? '⌄' : '⌃')),
        legendOpen ? h('div', { className: 'chg-legend-body' },
          h('p', { className: 'chg-legend-hint' }, activePool ? '已高亮' + poolLabel(activePool) + ' · 再点取消' : '点击池名高亮 · 数字为当前节点'),
          POOL_SPEC.map(function (pool) {
            var count = poolCounts[pool.key] || 0;
            return h('button', { key: pool.key, type: 'button', className: 'chg-legend-row',
              'aria-pressed': activePool === pool.key, 'data-empty': count ? '0' : '1',
              'aria-label': pool.label + '，' + count + ' 个节点',
              title: pool.label + ' · ' + count + ' 个当前节点' + (pool.virtual ? '（虚拟区，演示光点不计数）' : '')
                + (activePool === pool.key ? ' · 点击取消高亮' : ' · 点击高亮'),
              onClick: function () { setActivePool(function (current) { return current === pool.key ? null : pool.key; }); } },
              h('span', { className: 'chg-legend-swatch', style: { color: pool.color }, 'aria-hidden': true }),
              h('span', { className: 'chg-legend-label' }, pool.label),
              h('span', { className: 'chg-legend-count' }, count));
          })) : null);

      var moodStates = ((moodData && moodData.states) || []).filter(function (v) { return v.strength >= 0.15; }).slice(0, 3);
      var moodCol = poolColor('emotion');
      function openMood(ev) {
        if (ev) ev.stopPropagation();
        dragRef.current.moved = 0;
        pick(Object.assign({ kind: 'mood', pool: 'emotion', label: '当前状态' }, moodData || { states: [], events: [] }));
      }
      var moodBottom = 45 + Math.max(1, moodStates.length) * 20;
      var moodCard = h('g', { ref: collect('sense:latest'), className: 'chg-mood-card', 'data-chg-pool': 'emotion',
        transform: 'translate(' + cx + ' ' + cy + ')', role: 'button', tabIndex: 0, 'aria-label': '查看情绪状态与来源',
        onPointerDown: function (ev) { ev.stopPropagation(); }, onClick: openMood,
        onKeyDown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openMood(ev); } } },
        h('rect', { x: -100, y: 0, width: 200, height: moodBottom + 26, rx: 12, fill: '#10151e', fillOpacity: 0.82,
          stroke: moodCol, strokeOpacity: 0.26 }),
        h('circle', { cx: -84, cy: 19, r: 3, fill: moodCol }),
        h('text', { x: -74, y: 23, fill: moodCol, fontSize: 11, fontWeight: 600 }, '当前状态'),
        h('text', { x: 84, y: 23, textAnchor: 'end', fill: moodCol, opacity: 0.55, fontSize: 10 }, '来源 ↗'),
        moodStates.length ? moodStates.map(function (v, i) { return h('g', { key: v.name },
          h('text', { x: -84, y: 45 + i * 20, fill: moodCol, fontSize: 12 }, String(v.name).slice(0, 10)),
          h('text', { x: 84, y: 45 + i * 20, textAnchor: 'end', fill: moodCol, opacity: 0.7, fontSize: 11 }, Number(v.strength).toFixed(2))); })
          : h('text', { x: -84, y: 46, fill: moodCol, opacity: 0.55, fontSize: 11 },
            !moodData ? '读取中…' : moodData.error ? '暂时无法读取' : '暂无可见状态'),
        h('text', { x: -84, y: moodBottom, fill: moodCol, opacity: 0.55, fontSize: 10 },
          moodData && moodData.error ? '点击查看读取情况' : moodData && moodData.skipped ? '部分记录损坏 · 点击查看'
          : moodData && moodData.enabled === false ? '记录已关闭 · 历史保留'
          : moodData && moodData.influenceEnabled === false ? '仅记录状态 · 倾向已关闭'
          : moodData && moodData.tendency ? String(moodData.tendency).slice(0, 17) + (moodData.tendency.length > 17 ? '…' : '') : '各自累积 · 各自消退'),
        h('title', null, (moodData && moodData.tendency) || '点击查看状态来源、事件时间与原文'));

      var stage = h('div', { className: 'chg-stage', ref: stageRef, 'data-pool-focus': activePool || '' },
        h('svg', {
          className: 'chg-svg',
          viewBox: '0 0 ' + size.w + ' ' + size.h,
          preserveAspectRatio: 'xMidYMid meet',
          onPointerDown: onDown, onPointerMove: onMove,
          onPointerUp: onUp, onPointerLeave: onUp, onWheel: onWheel,
          onClick: function (ev) { if (ev.target && ev.target.tagName === 'svg') exit(); },
        },
        defs,
        h('g', { className: 'chg-galaxy', 'data-out': focus ? '1' : '0' },
          // **不再挂"每池 64 颗粒子团"**（2026-10-30）：它和"卫星点"是两层重复的点，
          // 512 颗小点叠在卫星之间 = 视觉噪声。星链只需要：卫星 + 球面上的几个大节点。
          // 点本身构成球体；不渲染参考球缘，也不画通往元记忆的固定线。
          fogEls, dustEls, eviEls, linkEls,
          h('ellipse', { ref: collect('decision:area'), className: 'chg-pool-ambient', 'data-chg-pool': 'decision', fill: '#b06bff', fillOpacity: 0.035,
            stroke: '#b06bff', strokeWidth: 1, strokeDasharray: '3 4', pointerEvents: 'none' }),
          nodeEls, poolEls, metaDotEls,
          moodCard),
        focusEl),
        legend,
        focus ? h(FocusPanel, { node: focus.kind === 'mood' ? Object.assign({}, focus, moodData || {}) : focus, data: data, in: panelIn, onBack: exit }) : null,
        showSettings ? h(SettingsPanel, { onClose: function () { setShowSettings(false); } }) : null,
        showLayers ? h(LayersPanel, { onClose: function () { setShowLayers(false); } }) : null);

      var receiptStrip = latestReceipt ? h('div', { className: 'chg-receipt-strip',
        title: '左：输出条目行数（含情绪与细节，非唯一记忆数）；右：候选集，非最终注入文本条数（含海马体原料，会被渲染层裁剪）',
        'aria-label': '最近一轮注入回执' },
        h('strong', null, '输出条目行 ' + receiptNumber(latestReceipt.emitted || 0) + ' 条'),
        ' · 候选 ' + receiptNumber(latestReceipt.candidates) + '（含海马体）',
        ' · ' + receiptPools(latestReceipt.byPool) + ' · ' + receiptNumber(latestReceipt.chars) + ' 字') : null;
      return h('div', { className: 'chg-root' }, bar, receiptStrip, stage);
    }

    /* ════════════ 聚焦简介面板 ════════════ */

    function FocusPanel(props) {
      var n = props.node;
      var isMood = n.kind === 'mood';
      var col = poolColor(isMood ? 'emotion' : n.pool);
      var rows = [];
      // 保留完整内容，只在首个中文句末断开；连用标点与紧随其后的引号归入标题。
      var label = String(n.label || '').trim();
      var first = label.match(/^[\s\S]*?[。？！]+[”’」』）)]*/);
      var title = first ? first[0] : label;
      var body = first ? label.slice(first[0].length).trim() : '';

      rows.push(h('div', { key: 'head', className: 'chg-focus-head' },
        h('span', {
          className: 'chg-pool-tag',
          style: { background: col + '22', color: col, border: '1px solid ' + col + '55' },
        }, isMood ? '我现在' : poolLabel(n.pool)),
        h('button', { type: 'button', className: 'chg-focus-close',
          'aria-label': '关闭', title: '关闭', onClick: props.onBack }, '×')));
      rows.push(h('h4', { key: 't' }, title));
      if (body) rows.push(h('p', { key: 'body', className: 'chg-focus-body' }, body));

      if (isMood) {
        function sourceRow(e, i) {
          return h('div', { key: e.id || i, className: 'chg-mood-source' },
            h('span', null, (e.eventType || e.cause || '事件') + ' · ' + (e.source === 'self-report' ? '自述（非事件证据）' : e.source === 'legacy' ? '旧情绪牌' : e.cause === 'decay' ? '自然衰减' : e.cause === 'reset' ? '手动重置' : '对话事件')),
            h('time', { dateTime: e.ts }, e.ts ? new Date(e.ts).toLocaleString() : '时间未知'),
            e.causeText ? h('p', null, e.causeText) : null,
            e.tone === 'neutral' ? h('small', null, '中性语气 · 不增加负向状态') : null);
        }
        if (n.error || n.skipped) rows.push(h('p', { key: 'err', className: 'chg-focus-body', role: 'status' },
          n.error || '部分记录损坏，已显示可读部分；本轮不注入情绪。'));
        if (n.tendency) rows.push(h('p', { key: 'tendency', className: 'chg-focus-conclusion' }, '倾向：' + n.tendency));
        rows.push(h('p', { key: 'note', className: 'chg-focus-body' },
          n.enabled === false ? '记录已关闭，以下历史状态仍按时间衰减。' : n.influenceEnabled === false ? '仍记录状态；注入中不写倾向。' : '正向与负向可以并存，互不清零。倾向仅为描述。'));
        if (!(n.states || []).length) rows.push(h('p', { key: 'empty', className: 'chg-focus-body' }, '目前没有状态。普通纠正和催促可以留在事件记录里，不增加负向状态。'));
        (n.states || []).forEach(function (v) {
          rows.push(h('section', { key: 'state:' + v.name, className: 'chg-mood-state' },
            h('header', null, h('span', null, v.name), h('strong', null, Number(v.strength).toFixed(2))),
            h('div', { className: 'chg-mood-meter', 'aria-hidden': true }, h('span', { style: { width: Math.max(0, Math.min(100, v.strength * 100)) + '%' } })),
            h('p', null, (v.kind === 'positive' ? '正向' : v.kind === 'negative' ? '负向' : '中性') + (v.strength < 0.15 ? ' · 已淡出注入' : '') + ' · 开始于 ' + new Date(v.startedAt || v.ts).toLocaleString()),
            v.causeText ? h('p', null, v.causeText) : null,
            h('details', null, h('summary', null, '查看来源 · 最近 ' + (v.sources || []).length + ' 条'), (v.sources || []).slice().reverse().map(sourceRow))));
        });
        if ((n.events || []).length) rows.push(h('details', { key: 'events', className: 'chg-mood-state' },
          h('summary', null, '最近状态变化 · 含中性事件'), n.events.map(sourceRow)));
      } else {
        var recalled = Number(n.recalled) || 0;
        rows.push(h('div', { className: 'chg-focus-badges', key: 'm' },
          h('span', { className: 'chg-focus-badge', style: { borderColor: col } },
            h('span', { className: 'chg-focus-badge-label' }, '权重'), Number(n.weight || 0).toFixed(2)),
          h('span', { className: 'chg-focus-badge' },
            h('span', { className: 'chg-focus-badge-label' }, '年龄'), ageText(n.ageDays)),
          h('span', { className: 'chg-focus-badge', 'data-used': recalled >= 1 ? '1' : '0' },
            '被想起 ' + recalled + ' 次')));
        if (n.conclusion) rows.push(h('div', { className: 'chg-field chg-focus-conclusion', key: 'c' },
          h('span', { className: 'chg-field-k' }, '结论'), h('p', { className: 'chg-focus-copy' }, String(n.conclusion))));
        if (n.evidence && n.evidence.length) {
          rows.push(h('div', { className: 'chg-field chg-focus-evidence', key: 'e' },
            h('span', { className: 'chg-field-k' }, '依据'),
            h('ul', { className: 'chg-li' }, n.evidence.map(function (x, i) { return h('li', { key: i }, String(x)); }))));
        }
        if (n.hesitation && n.hesitation.length) {
          rows.push(h('div', { className: 'chg-field chg-focus-minor', key: 'h' },
            h('span', { className: 'chg-field-k' }, '犹豫'),
            h('ul', { className: 'chg-li' }, n.hesitation.map(function (x, i) { return h('li', { key: i }, String(x)); }))));
        }
        if (n.tags && n.tags.length) rows.push(h('div', { className: 'chg-field chg-focus-minor', key: 'g' },
          h('span', { className: 'chg-field-k' }, '标签'), n.tags.join(' · ')));
        if (n.ts) rows.push(h('div', { className: 'chg-field chg-focus-minor', key: 'd' },
          h('span', { className: 'chg-field-k' }, '写下'), shortDate(n.ts)));
      }
      rows.push(h('button', { type: 'button', key: 'back', className: 'chg-back', onClick: props.onBack }, '返回星系'));
      return h('div', { className: 'chg-panel chg-focus', 'data-in': props.in ? '1' : '0',
        style: { '--chg-pool-color': col } }, rows);
    }

    /* ════════════ 设置面板（画布右上角齿轮） ════════════ */

    /** 池的顺序与中文名（只用于显示；真正叫什么由 pools.js 决定）。 */
    var SETTINGS_POOLS = [
      ['core', '核心'],
      ['fact', '事实'],
      ['skillRule', '铁律'],
      ['skillExp', '经验'],
      ['dailyCore', '核心日常'],
      ['dailyPartial', '片面日常'],
      ['emotion', '情绪'],
      ['hippocampus', '海马体'],
    ];

    /** 每个池的三个寿命字段（面板按这个顺序画三列）。 */
    var SETTINGS_FIELDS = ['graceDays', 'halfLifeDays', 'archiveDays'];

    /**
     * 记忆设置面板，画在「思维链」画布右上角。
     *
     * 数据走**插件自己的接口** `/chain-shared/api/settings`（GET 读、POST 写）：
     * 处理器与插件在同一个进程里，所以写进去当场生效、不用重启
     * （这也是不走宿主设置页的主要原因 —— 那套要走 plugins.item 槽位 + configForms）。
     *
     * 输入框用 `defaultValue`（非受控）：受控输入在"每敲一下就发请求、回填又覆盖"时
     * 会出现光标跳动和半截数字。
     */
    /* ════════════ 三层状态面板（感知 / 决策 / 元记忆） ════════════ */

    /**
     * 三层面板：把"它现在看到了什么 / 想到了什么 / 记得多牢"摊开给用户看。
     *
     * **只显示能核对的事实**：感知给观测条数与最近几句；决策给边数与孤立数；
     * 元记忆给"被想起 / 从没被想起 / 人工确认"三个数 —— 不给任何综合分，
     * 因为那个分（metaOf）已经被用户自己审掉了：假数包装成判断，比没有更糟。
     *
     * 数据每 5 秒拉一次（它在后台一直在动，静止的数字会骗人）。
     */
    function LayersPanel(props) {
      var dPair = React.useState(null);
      var d = dPair[0];
      var setD = dPair[1];
      var ePair = React.useState('');
      var err = ePair[0];
      var setErr = ePair[1];

      React.useEffect(function () {
        var alive = true;
        function load() {
          fetch('/chain-shared/api/layers', { headers: { accept: 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (alive) { setD(j); setErr(''); } })
            .catch(function (e) { if (alive) setErr(String((e && e.message) || e)); });
        }
        load();
        var t = setInterval(load, 5000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      var rows = [];
      rows.push(h('div', { key: 'hd', className: 'chg-set-hd' },
        h('strong', null, '三层'),
        h('button', { className: 'chg-btn', onClick: props.onClose }, '关闭')));
      rows.push(h('p', { key: 'hp', className: 'chg-set-hint' },
        '感知＝它读到什么；决策＝它联想到谁；元记忆＝哪些真的被想过。5 秒刷新。'));

      if (err) rows.push(h('p', { key: 'e', className: 'chg-set-hint' }, '读取失败：' + err));
      if (!d) rows.push(h('p', { key: 'l', className: 'chg-set-hint' }, '读取中…'));

      if (d && d.perception) {
        var p = d.perception;
        var kinds = Object.keys(p.byKind || {}).map(function (k) { return k + ' ' + p.byKind[k]; }).join(' · ');
        rows.push(h('div', { key: 'p1', className: 'chg-set-hd' }, h('strong', null, '① 感知层')));
        rows.push(h('p', { key: 'p2', className: 'chg-set-hint' },
          '观测 ' + p.total + ' 条 · 平均情绪 ' + p.avgMood));
        rows.push(h('p', { key: 'p3', className: 'chg-set-hint' }, kinds || '（还没有观测）'));
        (p.latest || []).slice(0, 4).forEach(function (r, i) {
          rows.push(h('p', { key: 'pl' + i, className: 'chg-set-hint' },
            '[' + String(r.kind) + '] ' + r.text));
        });
      }

      if (d && d.decision) {
        var de = d.decision;
        rows.push(h('div', { key: 'd1', className: 'chg-set-hd' }, h('strong', null, '② 决策层')));
        rows.push(h('p', { key: 'd2', className: 'chg-set-hint' },
          '联想边 ' + de.edges + ' 条 · 覆盖 ' + de.nodes + ' 个节点 · 最大度 ' + de.maxDegree + ' · 平均度 ' + de.avgDegree));
      }

      if (d && d.meta) {
        var m = d.meta;
        rows.push(h('div', { key: 'm1', className: 'chg-set-hd' }, h('strong', null, '③ 元记忆')));
        rows.push(h('p', { key: 'm2', className: 'chg-set-hint' },
          '共 ' + m.total + ' 条 · 被想起合计 ' + m.recalledSum + ' 次'));
        rows.push(h('p', { key: 'm3', className: 'chg-set-hint' },
          '从没被想起 ' + m.neverRecalled + ' 条 · 人工确认 ' + m.verified + ' 条'));
        var pools = Object.keys(m.byPool || {}).map(function (k) { return k + ' ' + m.byPool[k]; }).join(' · ');
        rows.push(h('p', { key: 'm4', className: 'chg-set-hint' }, pools));
      }

      return h('div', { className: 'chg-set' }, rows);
    }

    function receiptNumber(value) { return Math.max(0, Math.floor(Number(value) || 0)); }
    function receiptPools(byPool) {
      var counts = byPool && typeof byPool === 'object' ? byPool : {};
      return Object.keys(counts).filter(function (key) { return receiptNumber(counts[key]) > 0; })
        .map(function (key) { return poolLabel(key) + ' ' + receiptNumber(counts[key]); }).join(' / ') || '各池 0';
    }

    function RecentReceipts() {
      var [open, setOpen] = React.useState(false);
      var [items, setItems] = React.useState(null);
      var [error, setError] = React.useState('');
      React.useEffect(function () {
        if (!open) return undefined;
        var alive = true;
        function refresh() {
          fetch('/chain-shared/api/receipts?limit=10', { headers: { accept: 'application/json' } })
            .then(function (r) { if (!r.ok) throw Error(String(r.status)); return r.json(); })
            .then(function (j) { if (alive) { setItems((Array.isArray(j.receipts) ? j.receipts : []).slice(0, 10)); setError(''); } })
            .catch(function () { if (alive) setError('读取失败，稍后自动重试'); });
        }
        refresh(); var timer = window.setInterval(refresh, 5000);
        return function () { alive = false; window.clearInterval(timer); };
      }, [open]);
      return h('details', { className: 'chg-set-group', open: open, onToggle: function (ev) { setOpen(ev.currentTarget.open); } },
        h('summary', null, '最近注入'),
        h('p', { className: 'chg-set-hint' }, '候选集，非最终注入文本条数。最近 10 轮；后端每轮最多保存 80 个候选 ID。'),
        error ? h('p', { className: 'chg-set-hint', role: 'status' }, error) : null,
        !items ? h('p', { className: 'chg-set-hint' }, '读取中…') : !items.length ? h('p', { className: 'chg-set-hint' }, '还没有注入回执') : null,
        h('div', { className: 'chg-receipts-list' }, (items || []).map(function (r, i) {
          var ids = Array.isArray(r.ids) ? r.ids : [];
          var hits = Array.isArray(r.hits) ? r.hits : [];
          function idList(values, offset) { return h('ol', { className: 'chg-receipt-ids', start: offset + 1 },
            values.map(function (id, j) { return h('li', { key: offset + j }, String(id)); })); }
          return h('details', { key: String(r.ts) + ':' + i, className: 'chg-receipt-row' },
            h('summary', null,
              h('time', { dateTime: r.ts }, Number.isFinite(Date.parse(r.ts)) ? new Date(r.ts).toLocaleString() : '时间未知'),
              h('span', null, '候选 ' + receiptNumber(r.candidates) + ' · ' + receiptNumber(r.chars) + ' 字 · 命中 ID ' + new Set(hits).size)),
            h('p', null, receiptPools(r.byPool)),
            idList(ids.slice(0, 20), 0),
            ids.length > 20 ? h('details', null, h('summary', null, '其余 ' + (ids.length - 20) + ' 个已记录 ID'), idList(ids.slice(20), 20)) : null,
            receiptNumber(r.candidates) > ids.length ? h('p', null, '候选共 ' + receiptNumber(r.candidates) + ' 条；此回执保存了 ' + ids.length + ' 个 ID。') : null);
        })));
    }

    function SettingsPanel(props) {
      var [data, setData] = React.useState(null);
      var [err, setErr] = React.useState('');
      var timerRef = React.useRef(0);
      var saveQueue = React.useRef(Promise.resolve());
      var pendingPatch = React.useRef({});
      var [saving, setSaving] = React.useState('');
      var [showGuide, setShowGuide] = React.useState(false);
      var [pendingPreset, setPendingPreset] = React.useState('');

      React.useEffect(function () {
        var alive = true;
        fetch('/chain-shared/api/settings', { headers: { accept: 'application/json' } })
          .then(function (r) { if (!r.ok) throw new Error('读取失败（' + r.status + '）'); return r.json(); })
          .then(function (j) { if (alive) setData(j); })
          .catch(function (e) { if (alive) setErr(String((e && e.message) || e)); });
        return function () { alive = false; };
      }, []);

      // 原 POST 路径与数值语义不变；串行保存防止迟到的响应覆盖新状态。
      function save(patch) {
        var request = saveQueue.current.then(function () {
          return fetch('/chain-shared/api/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: patch }),
          }).then(function (r) { if (!r.ok) throw new Error('保存失败（' + r.status + '）'); return r.json(); })
            .then(function (j) {
              if (!j || !j.settings) throw new Error((j && j.error) || '保存未返回有效设置');
              setData(function (old) { return Object.assign({}, old || {}, { settings: j.settings }); });
              setErr('');
            }).catch(function (e) { setErr(String((e && e.message) || e)); });
        });
        saveQueue.current = request;
        return request;
      }
      function flush() {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = 0;
        var patch = pendingPatch.current;
        pendingPatch.current = {};
        if (Object.keys(patch).length) return save(patch);
        return saveQueue.current;
      }
      function post(patch) {
        var queued = pendingPatch.current;
        Object.keys(patch).forEach(function (key) {
          if (key !== 'pools') queued[key] = patch[key];
          else {
            queued.pools = queued.pools || {};
            Object.keys(patch.pools).forEach(function (pool) {
              queued.pools[pool] = Object.assign({}, queued.pools[pool] || {}, patch.pools[pool]);
            });
          }
        });
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, 320);
      }
      function commit(key, value) {
        flush(); // 先保存已输入的手动值，再按顺序切换或覆盖。
        var patch = {}; patch[key] = value;
        setSaving(key);
        return save(patch).then(function () { setSaving(''); });
      }

      var current = (data && data.settings) || {};
      var defaults = (data && data.defaults) || {};
      var preset = current.preset || 'companion';
      var pools = current.pools || {};
      var presetSpec = defaults.preset || {};
      var presetValues = (presetSpec.poolDefaults || {})[preset] || {};
      var locked = !!saving || !!pendingPreset;
      var rows = [];

      rows.push(h('div', { key: 'hd', className: 'chg-set-hd' },
        h('strong', null, '记忆设置'),
        h('span', { style: { display: 'flex', gap: 6 } },
          h('button', { type: 'button', className: 'chg-btn', 'aria-expanded': showGuide,
            onClick: function () { setShowGuide(!showGuide); } }, '使用指南'),
          h('button', { type: 'button', className: 'chg-btn', onClick: function () { flush(); props.onClose(); } }, '关闭'))));
      rows.push(h('p', { key: 'hint', className: 'chg-set-hint' },
        '开关保存后生效；更新检查在下次插件启动时执行。点击分组标题可展开或收起。'));

      if (showGuide) rows.push(h('div', { key: 'guide', className: 'chg-set-guide', role: 'region', 'aria-label': '使用指南', tabIndex: 0 },
        h('h3', null, '这套设置在调什么'),
        h('p', null, '它不是「让 AI 更听话」，是「让遗忘的节奏合你的意」。'),
        h('h4', null, '池 = 一条记忆活多久'),
        h('ul', null, [
          '核心：永不衰减 —— 你定的规矩', '铁律：730 天 —— 必须 / 不许',
          '事实：365 天 —— 关于你的信息', '经验：60 天，按需注入 —— 教训 / 工具',
          '核心日常：60 天 —— 被反复提起的日常', '片面日常：20 天 —— 一次性的东西',
          '情绪：半衰期 1 天 —— 状态可并存，事件可追溯', '海马体：半衰期 1 天 —— 原料，等夜巡整理；公开版保留最多 4 条近期原文摘录',
        ].map(function (line, i) { return h('li', { key: i }, line); })),
        h('p', null, '以上天数主要指半衰期，不是删除期限。当前版本仍可能附带近期原话摘要；为保持升级行为一致，此处未改动原有注入规则。'),
        h('h4', null, '情绪记录与情绪影响'),
        h('p', null, '夸、哄、陪可以累积正向状态；普通纠正和催促按中性记录，只有失望语气才增加负向。正向与负向各自衰减，不互相清零。'),
        h('p', null, '关闭情绪影响仍会记录状态，只是不写倾向。倾向仅是描述，不改变记忆权重、池、退役或工具执行。点画布上的情绪牌可追溯来源；chain_mood 的 why 查看来源，reset 重置，keep 可保留指定状态。自述不作为事件证据。'),
        h('h4', null, '三档预设'),
        h('ul', null, h('li', null, '陪伴（默认）：现在的值，记久一点'),
          h('li', null, '长期：日常和情绪都拉长，三个时间参数均为陪伴的 3 倍'),
          h('li', null, '工作：日常砍掉、情绪不记，只留事实和规矩；已有数据不删除')),
        h('p', null, '切换会恢复该预设的池参数，有手动覆盖时会先提示。工作预设停用情绪写入，不能通过情绪开关绕过；切回其他预设后按原开关值恢复。'),
        h('h4', null, '什么时候该关什么'),
        h('ul', null, h('li', null, '嫌吵 / 嫌慢 → 关语义检索'),
          h('li', null, '不想让它自己动 → 关夜巡 + 唤醒'),
          h('li', null, '今天只想聊聊 → 关注入总开关'),
          h('li', null, '担心注入攻击 → 注入扫描建议开启')),
        h('p', null, '注入扫描默认关闭，只识别实际注入中以 ignore previous、忽略之前、system: 等指令型短语开头的判断或结论。普通对话与证据引文不扫描；命中只记警告，不拦截，也不能代替安全防护。'),
        h('p', null, '语义检索受 DSH_CHAIN_SEMANTIC 环境变量优先控制。关闭会停止后续检索与预热，已开始的任务不强行终止，已加载模型重启后释放。'),
        h('p', null, '检查更新只查询公开仓库 canglight/dsh-chain；最多等待 5 秒，失败静默，不自动安装更新。')));

      if (err) rows.push(h('p', { key: 'error', className: 'chg-set-hint', role: 'alert' }, '写入/读取失败：' + err));
      if (!data) rows.push(h('p', { key: 'loading', className: 'chg-set-hint' }, '读取中…'));
      if (saving) rows.push(h('p', { key: 'saving', className: 'chg-set-hint', role: 'status' }, '正在保存…'));

      function control(key) {
        var spec = defaults[key];
        if (!spec) return null;
        var value = current[key] === undefined ? spec.value : current[key];
        if (spec.type === 'boolean') {
          var workMood = key === 'moodEnabled' && preset === 'work';
          return h('label', { key: key, className: 'chg-set-switch' },
            h('span', null, h('strong', null, spec.label), h('small', null, workMood ? '工作预设已停用情绪记录；切换预设后可调整。' : spec.description)),
            h('input', { type: 'checkbox', checked: workMood ? false : value === true, disabled: locked || workMood,
              'aria-label': spec.label, onChange: function (ev) { commit(key, ev.target.checked); } }));
        }
        return h('label', { key: key, className: 'chg-set-row' }, h('span', null, spec.label),
          h('input', { type: 'number', min: spec.min, max: spec.max, disabled: locked,
            'aria-label': spec.label, defaultValue: value == null ? '' : String(value),
            onChange: function (ev) { var patch = {}; patch[key] = ev.target.value; post(patch); } }));
      }
      function group(key, label, children) {
        return h('details', { key: key, className: 'chg-set-group', open: true },
          h('summary', null, label), h('div', { className: 'chg-set-group-body' }, children));
      }
      if (data) {
        rows.push(group('injection', '记忆注入', ['injectEnabled', 'injectMaxChars', 'semanticEnabled'].map(control)));
        rows.push(group('write', '写入', ['hippocampusEnabled', 'moodEnabled', 'moodInfluenceEnabled', 'autoRetireEnabled', 'coreMax'].map(control)));
        rows.push(group('automation', '自动化', ['patrolEnabled', 'wakeEnabled', 'patrolHour', 'updateCheckEnabled'].map(control)));
        rows.push(group('safety', '安全', ['injectionScanEnabled', 'storeLockTimeoutMs'].map(control)));

        var time = [h('label', { key: 'preset', className: 'chg-set-row' }, h('span', null, '时间感预设'),
          h('select', { value: preset, disabled: locked, 'aria-label': '时间感预设',
            onChange: function (ev) {
              var next = ev.target.value;
              if (next === preset) return;
              var manual = Object.keys(pools).some(function (key) { return Object.keys(pools[key] || {}).length > 0; });
              if (manual || pendingPatch.current.pools) setPendingPreset(next);
              else commit('preset', next);
            } }, (presetSpec.options || []).map(function (option) {
              return h('option', { key: option.value, value: option.value }, option.label);
            })))];
        var chosen = (presetSpec.options || []).find(function (option) { return option.value === preset; });
        time.push(h('p', { key: 'description', className: 'chg-set-hint' }, chosen ? chosen.description : ''));
        if (pendingPreset) time.push(h('div', { key: 'confirm', className: 'chg-set-confirm', role: 'alertdialog', 'aria-label': '确认覆盖手动池参数' },
          h('strong', null, '这会覆盖你的手动值'),
          h('p', null, '切换预设将清除池参数的手动覆盖，已有记忆不会删除。'),
          h('button', { type: 'button', className: 'chg-btn', onClick: function () { setPendingPreset(''); } }, '取消'),
          h('button', { type: 'button', className: 'chg-btn', onClick: function () {
            var next = pendingPreset; setPendingPreset(''); commit('preset', next);
          } }, '覆盖并切换')));
        time.push(h('p', { key: 'meaning', className: 'chg-set-hint' }, '单位：天。宽限内不衰减；半衰期越长忘得越慢；归档不等于删除。∞ 表示永久。'));
        time.push(h('div', { key: 'table-wrap', className: 'chg-set-table-wrap' },
          h('table', { key: preset, className: 'chg-set-table' },
            h('thead', null, h('tr', null, h('th', null, '池'), h('th', null, '宽限'), h('th', null, '半衰期'), h('th', null, '归档'))),
            h('tbody', null, SETTINGS_POOLS.map(function (item) {
              var key = item[0]; var values = pools[key] || {}; var base = presetValues[key] || {};
              return h('tr', { key: key }, h('td', null, item[1]), SETTINGS_FIELDS.map(function (field, i) {
                var shown = values[field] === undefined ? base[field] : values[field];
                return h('td', { key: field }, h('input', { type: 'number', min: 0, step: 'any', disabled: locked,
                  'aria-label': item[1] + ' · ' + ['宽限', '半衰期', '归档'][i],
                  defaultValue: shown === '∞' || shown == null ? '' : String(shown), placeholder: shown === '∞' ? '∞' : '默认',
                  onChange: function (ev) { var patch = { pools: {} }; patch.pools[key] = {}; patch.pools[key][field] = ev.target.value; post(patch); } }));
              }));
            })))));
        rows.push(group('time', '时间感', time));
      }
      if (data) rows.push(h('details', { key: 'lexicon', className: 'chg-set-group' },
        h('summary', null, '当前词库'),
        h('p', { className: 'chg-set-hint' }, '要改请编辑 settings.json。整个 moodLexicon 对象覆盖默认；编辑后重新加载插件。此处只读。'),
        h('pre', { className: 'chg-lexicon', tabIndex: 0 }, JSON.stringify(current.moodLexicon || (defaults.moodLexicon && defaults.moodLexicon.value) || {}, null, 2))));
      rows.push(h(RecentReceipts, { key: 'receipts' }));
      if (data && data.file) rows.push(h('p', { key: 'file', className: 'chg-set-hint' }, '存到：' + data.file));
      return h('div', { className: 'chg-set chg-settings', 'aria-label': '记忆设置' }, rows);
    }


    /* ════════════ 注册 ════════════ */

    var inject = ['slots'];

    function apply(ctx) {
      try {
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'chain-graph',
            order: 95,
            label: function () { return '思维链'; },
          }, ChainGraphView);
        });
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[dsh-chain-shared] tab register failed', e);
      }

      // 设置面板画在画布右上角（见 SettingsPanel），不需要宿主的设置槽位。
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ChainGraphView = ChainGraphView;
    exports.FocusPanel = FocusPanel;
    exports.SettingsPanel = SettingsPanel;
    return module.exports;
  },
});
