/** Offline release checks. All module imports and data writes run in a child with a temporary HOME. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
let failures = 0;
async function check(label, fn) {
  try { const detail = await fn(); console.log('✅ ' + label + (detail ? '：' + detail : '')); }
  catch (e) { failures++; console.log('❌ ' + label + '：' + String(e?.message || e)); }
}
const text = rel => fs.readFileSync(path.join(root, rel), 'utf8');

if (process.argv.includes('--smoke')) {
  // Fail before importing project modules if the parent did not isolate the home directory.
  assert.ok(process.env.DSH_CHAIN_VERIFY_HOME);
  assert.equal(path.resolve(os.homedir()), path.resolve(process.env.DSH_CHAIN_VERIFY_HOME));
  globalThis.fetch = async () => { throw new Error('Verification is offline'); };
  const mod = name => import(pathToFileURL(path.join(root, 'lib', name + '.js')));
  const config = await mod('config'), store = await mod('store'), mood = await mod('mood');
  const receipt = await mod('receipt'), main = await mod('index'), pools = await mod('pools');
  const api = await mod('api');
  const reset = patch => config.applyConfig(config.mergeSettings({}, patch || {}));
  config.configurePoolPresets(pools.POOLS);
  const tools = new Map(), hooks = new Map();
  let section, mount;
  const quiet = () => {};
  const ctx = {
    logger: { info: quiet, warn: quiet },
    tools: { register(tool) { tools.set(tool.name, tool); return quiet; } },
    systemPrompt: { section(value) { section = value; return quiet; } },
    on(name, fn) { hooks.set(name, fn); return quiet; },
    inject(names, fn) { if (names.includes('webServer')) fn({ webServer: { register(value) { mount = value; return quiet; } } }); },
  };
  await check('加载主模块', () => { assert.equal(typeof main.apply, 'function'); return 'import 成功'; });
  await check('共享隔离', () => {
    assert.equal(config.STORE_DIR_NAME, '.chain-shared');
    assert.equal(config.storeDir(), path.join(os.homedir(), '.dsh', 'memories', '.chain-shared'));
    assert.ok(config.isTargetSession('session-test-a'));
    assert.ok(!config.isTargetSession('test-b', ['test-a']));
    assert.ok(config.isTargetSession('session-test-a', ['test-a']));
    assert.ok(!config.isTargetSession(''));
    return '临时 HOME；全会话默认与显式目标匹配通过';
  });
  await check('loadAll 四分支与坏行', () => {
    assert.deepEqual(store.loadAll(), { entries: [], skipped: 0, hasIssue: false, error: '' });
    fs.mkdirSync(config.storeDir(), { recursive: true });
    fs.writeFileSync(config.storePath(), '{broken\n');
    const bad = store.loadAll();
    assert.equal(bad.hasIssue, true); assert.equal(bad.skipped, 1);
    fs.unlinkSync(config.storePath());
    fs.mkdirSync(config.storePath());
    const unreadable=store.loadAll();
    assert.equal(unreadable.hasIssue,true);assert.match(unreadable.error,/STORE_READ_FAILED/);
    fs.rmdirSync(config.storePath());
    const mkdir=fs.mkdirSync;
    try {
      fs.mkdirSync=(...args)=>{
        if(String(args[0]).includes('.dsh-chain-locks')) throw Object.assign(new Error('simulated lock directory failure'),{code:'ENOSPC'});
        return mkdir(...args);
      };
      syncBuiltinESMExports();
      const lockFailure=store.loadAll();
      assert.equal(lockFailure.hasIssue,true);assert.match(lockFailure.error,/ENOSPC/);
    } finally {fs.mkdirSync=mkdir;syncBuiltinESMExports();}
    assert.equal(store.loadAll().hasIssue,false);
    return '缺文件 / 正常与坏行 / 读取失败 / 锁失败均含 hasIssue';
  });
  await check('默认配置和预设', () => {
    reset();
    for (const key of ['injectEnabled','semanticEnabled','hippocampusEnabled','patrolEnabled','wakeEnabled','moodEnabled','moodInfluenceEnabled','autoRetireEnabled']) assert.equal(config.getConfig()[key], true, key);
    for (const key of ['injectionScanEnabled','updateCheckEnabled']) assert.equal(config.getConfig()[key], false, key);
    assert.equal(config.getConfig().preset, 'companion');
    for (const key of Object.keys(pools.POOLS)) assert.deepEqual(pools.poolDef(key), pools.POOLS[key]);
    reset({preset:'longterm'}); assert.equal(pools.poolDef('dailyCore').halfLifeDays, pools.POOLS.dailyCore.halfLifeDays * 3);
    reset({preset:'work'}); assert.equal(pools.poolDef('dailyCore').halfLifeDays, 1 / 86400);
    reset(); return '陪伴逐字段相同；长期 / 工作实际改变池参数';
  });
  await check('语气分类和词库覆盖', () => {
    for (const [input, kind] of [['这里错了','neutral'],['你怎么又忘了','negative'],['摸摸','positive']]) assert.equal(mood.classifyMoodEvents(input)[0]?.kind, kind, input);
    reset({moodLexicon:{夸:{positive:['测试赞语']}}});
    assert.equal(mood.classifyMoodEvents('摸摸').length, 0);
    assert.equal(mood.classifyMoodEvents('测试赞语')[0]?.kind, 'positive');
    reset(); return '中性纠正 / 失望负向 / 安抚正向；词库整体覆盖';
  });
  await check('旧情绪兼容与事件流', () => {
    fs.writeFileSync(mood.moodPath(), JSON.stringify({ts:new Date().toISOString(),mood:'服气',why:'兼容验证',intensity:0.55}));
    assert.equal(mood.readMood()?.mood, '服气');
    assert.equal(mood.recordMoodEvents('厉害。这里错了。摸摸').written, 3);
    const report = mood.readMoods();
    assert.equal(report.events.find(e => e.eventType === '纠正').kind, 'neutral');
    assert.ok(fs.existsSync(mood.moodPath()));
    assert.equal(fs.readFileSync(mood.moodsPath(),'utf8').trim().split('\n').length,3);
    return '旧 mood.json 保留；3 条变化已写入临时 moods.jsonl';
  });
  await check('状态并存与影响开关', () => {
    mood.recordMoodStates([{name:'开心',intensity:0.9},{name:'难过',intensity:0.8}]);
    assert.ok(['开心','难过'].every(name => mood.readMoods().states.some(s => s.name === name)));
    const full = mood.formatMoodInjection();
    assert.ok(full.includes('当前状态：') && full.includes('倾向：') && full.length <= 200);
    assert.ok((full.match(/^- /gm)||[]).length <= 3);
    reset({moodInfluenceEnabled:false});
    assert.ok(!mood.formatMoodInjection().includes('倾向：'));
    assert.equal(mood.recordMoodEvents('摸摸').written,1);
    reset({moodEnabled:false}); assert.equal(mood.recordMoodEvents('摸摸').written,0);
    assert.equal(mood.formatMoodInjection(),'');
    reset(); return '正负并存；短段 ≤200；关闭影响仍记录，关闭记录不再写入';
  });
  await check('宿主注册与工具 why/reset', async () => {
    // No timer service is supplied; no real patrol, wake process or embedding model can start.
    const previous = console.log;
    try { console.log = quiet; main.apply(ctx,{}); } finally { console.log = previous; }
    assert.equal(mount.path, '/chain-shared');
    assert.equal(tools.size,9);
    assert.ok(tools.has('chain_import'));
    const why = await tools.get('chain_mood').execute({op:'why'});
    assert.ok(why.ok && why.states.some(s => s.sources.length));
    await tools.get('chain_mood').execute({op:'reset',keep:['开心']});
    assert.deepEqual(mood.readMoods().states.map(s=>s.name),['开心']);
    await tools.get('chain_mood').execute({op:'reset'});
    assert.equal(mood.readMoods().states.length,0);
    return '9 个工具（含 chain_import）；共享挂载；来源可查、重置可用';
  });
  await check('2.4.1 批量导入与写入校验', async () => {
    const input={appends:[{judgement:'公开版批量导入验证',evidence:['合成测试数据'],pool:'fact'}]};
    const initial=store.loadAll().entries.length;
    const preview=await tools.get('chain_import').execute({...input,dryRun:true});
    assert.equal(preview.ok,true);assert.equal(preview.created[0].id,'');
    assert.equal(store.loadAll().entries.length,initial);
    const imported=await tools.get('chain_import').execute(input);
    assert.equal(imported.ok,true);assert.equal(imported.created.length,1);
    assert.equal(store.loadAll().entries.find(e=>e.id===imported.created[0].id).pool,'fact');
    const bytes=fs.readFileSync(config.storePath());
    for (const invalid of [[{judgement:'missing id'}],[null]]) {
      const result=store.appendChainBatch(invalid);
      assert.equal(result.written,0);assert.match(result.error,/BATCH_ROW_INVALID/);
      assert.deepEqual(fs.readFileSync(config.storePath()),bytes);
    }
    return 'dry-run 零写入；正式导入/定池成功；非法批量行拒绝且零写入';
  });
  await check('注入、回执与总开关', () => {
    reset(); store.appendChain({judgement:'验证事实条目',conclusion:'验证结论',tags:['用户'],weight:0.8});
    mood.recordMoodEvents('摸摸');
    const injected = main.buildInjection('test-a',[],'验证事实');
    assert.ok(injected.includes('验证事实条目') && injected.includes('当前状态：') && injected.includes('倾向：'));
    const report = receipt.readReceipts(1);
    assert.ok(report.count > 0 && report.receipts.length === 1);
    assert.equal(report.receipts[0].chars,injected.length);
    assert.ok(Array.isArray(report.receipts[0].ids) && Array.isArray(report.receipts[0].hits));
    reset({injectEnabled:false}); assert.equal(main.buildInjection('test-a'),'');
    assert.equal(section.text({scope:{id:'test-a'}}),'');
    reset(); return '真实 buildInjection 生成回执；关闭后返回空注入';
  });
  await check('海马体 / 夜巡 / 自动退役开关', async () => {
    const scope = message => ({id:'test-a',session:{deriveMessages:()=>[{role:'user',content:message}]}});
    reset({hippocampusEnabled:false,moodEnabled:false});
    const count = store.loadAll().entries.length;
    section.text({scope:scope('这是海马体验证片段，确认关闭后不会新增记录。')});
    assert.equal(store.loadAll().entries.length,count);
    reset({moodEnabled:false}); section.text({scope:scope('这是另一段海马体验证片段，开启记录后应写入原料池。')});
    assert.ok(store.loadAll().entries.length > count);
    reset({patrolEnabled:false});
    await assert.rejects(()=>tools.get('chain_patrol').execute({}),/夜巡已关闭/);
    const old = store.appendChain({eventId:'verify-event',judgement:'先使用旧方案',conclusion:'旧方案',tags:['用户']});
    reset({autoRetireEnabled:false});
    await tools.get('chain_append').execute({eventId:'verify-event',judgement:'改成新方案',conclusion:'新方案',tags:['用户']});
    assert.ok(!store.loadAll().entries.find(e=>e.id===old.id).superseded);
    reset();
    await tools.get('chain_append').execute({eventId:'verify-event',judgement:'换成最终方案',conclusion:'最终方案',tags:['用户']});
    assert.ok(store.loadAll().entries.find(e=>e.id===old.id).superseded);
    return '关闭停止对应行为，重新开启恢复写入 / 自动退役';
  });
  const request = async (url, patch) => {
    const req = Readable.from(patch ? [JSON.stringify({settings:patch})] : []);
    req.url = url; req.method = patch ? 'POST' : 'GET';
    let status, body;
    await api.createHandler()(req,{writeHead(n){status=n;},end(s){body=JSON.parse(s);}});
    return {status,body};
  };
  await check('共享 API 与设置保存', async () => {
    for (const endpoint of ['receipts?limit=1','moods?limit=3','settings']) assert.equal((await request('/chain-shared/api/'+endpoint)).status,200);
    assert.equal((await request('/chain/api/receipts')).status,404);
    const result = await request('/chain-shared/api/settings',{injectEnabled:false,moodInfluenceEnabled:false});
    assert.equal(result.status,200); assert.equal(config.getConfig().injectEnabled,false);
    assert.equal(config.readSettingsFile().moodInfluenceEnabled,false);
    reset(); return '新接口只读；原 POST 保存路径仍可当场生效';
  });
  await check('写盘失败不阻断注入', () => {
    // Turn journal paths into directories to exercise a genuine write error inside temporary HOME.
    fs.unlinkSync(receipt.receiptFile()); fs.mkdirSync(receipt.receiptFile());
    fs.unlinkSync(mood.moodsPath()); fs.mkdirSync(mood.moodsPath());
    assert.equal(receipt.recordReceipt({}),false);
    assert.equal(mood.recordMoodEvents('摸摸').ok,false);
    assert.ok(main.buildInjection('test-a').includes('验证事实条目'));
    return '回执 / 情绪写失败时，记忆文本仍正常返回';
  });
  hooks.get('dispose')?.();
} else {
  await check('语法', () => {
    const files = fs.readdirSync(path.join(root,'lib')).filter(f=>f.endsWith('.js'));
    for (const file of [...files.map(f=>path.join(root,'lib',f)),script]) {
      const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr);
    }
    return 'lib/*.js 共 '+files.length+' 个文件及 verify.mjs 通过';
  });
  await check('私人内容扫描', () => {
    // Keep private words outside this publishable script. Values are literal strings, never regexes.
    // Accept a JSON string array, or words separated by comma, pipe or newline.
    const raw=String(process.env.CHAIN_BANNED_WORDS || '').trim();
    let banned;
    try { banned=raw.startsWith('[') ? JSON.parse(raw) : raw.split(/[,|\r\n]+/); }
    catch { throw new Error('CHAIN_BANNED_WORDS 的 JSON 格式无效'); }
    assert.ok(Array.isArray(banned) && banned.every(word=>typeof word==='string'), 'CHAIN_BANNED_WORDS 必须是字符串数组或分隔词表');
    banned=[...new Set(banned.map(word=>word.trim()).filter(Boolean))];
    const uuid=/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    const files = fs.readdirSync(path.join(root,'lib')).filter(f=>/\.m?js$/.test(f)).map(f=>'lib/'+f)
      .concat(['README.md','CHANGELOG.md','package.json','tools/verify.mjs','.github/ISSUE_TEMPLATE/bug_report.md','examples/mood-lexicon.rich.json']);
    const hits=[];
    for (const file of files) {
      // Permit the normal package author credit, without exempting other package fields.
      const source=file==='package.json' ? JSON.stringify({...JSON.parse(text(file)),author:undefined},null,2) : text(file);
      source.split(/\r?\n/).forEach((line,i)=>{
      if (file==='README.md' && /^署名[:：]/.test(line)) return;
      // Report positions only: never echo a private match into logs.
      if (uuid.test(line) || banned.some(word=>line.includes(word))) hits.push(file+':'+(i+1));
      });
    }
    assert.deepEqual(hits,[]);
    return banned.length ? '环境词表 '+banned.length+' 项 + UUID：零命中（保留正常署名）'
      : 'UUID 零命中；CHAIN_BANNED_WORDS 未设置，未执行私人词表检查';
  });
  await check('共享前缀与隔离常量', () => {
    for (const file of ['index.js','api.js','client.js']) {
      const source=text('lib/'+file);
      assert.ok(source.includes('/chain-shared'),file);
      assert.ok(!/\/chain(?=\/|['"`\s])/.test(source),file+' contains private prefix');
    }
    const source=text('lib/config.js');
    assert.ok(source.includes('process.env.DSH_CHAIN_TARGET_SESSION_IDS'));
    assert.ok(source.includes("STORE_DIR_NAME = '.chain-shared'"));
    assert.ok(source.includes('isTargetSession(scopeId, targets = DEFAULT_TARGET_SESSIONS)'));
    assert.ok(text('lib/client.js').includes("id: 'dsh-chain-shared'"));
    return '挂载 / 路由 / fetch 统一为 /chain-shared；三处隔离保留';
  });
  let temporary;
  await check('临时 HOME 冒烟', () => {
    temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-chain-verify-'));
    const result=spawnSync(process.execPath,[script,'--smoke'],{
      env:{...process.env,HOME:temporary,USERPROFILE:temporary,DSH_CHAIN_VERIFY_HOME:temporary,DSH_CHAIN_TARGET_SESSION_IDS:'',DSH_CHAIN_SEMANTIC:'0'},
      encoding:'utf8',windowsHide:true,timeout:60000,
    });
    if(result.stdout) process.stdout.write(result.stdout);
    assert.equal(result.status,0,result.stderr || '子进程验证失败');
    return '离线完成，未连接运行中的 DSH';
  });
  await check('清理验证数据', () => {
    if(temporary) {
      const resolved=path.resolve(temporary), base=path.resolve(os.tmpdir());
      assert.equal(path.dirname(resolved),base);
      assert.ok(path.basename(resolved).startsWith('dsh-chain-verify-'));
      assert.ok(!fs.lstatSync(resolved).isSymbolicLink());
      fs.rmSync(resolved,{recursive:true,force:true});
    }
    return '仅删除本次新建的临时 HOME';
  });
}
if (!process.argv.includes('--smoke')) console.log('RESULT: '+(failures?'FAIL':'PASS')+' ('+failures+' 项失败)');
process.exitCode=failures?1:0;
