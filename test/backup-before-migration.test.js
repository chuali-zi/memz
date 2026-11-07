const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),script='scripts/backup-before-migration.sh';
const recipeSection=fs.readFileSync(path.join(root,'README.md'),'utf8').split('## 保留数据升级')[1].split('## 验证')[0];
const blocks=[...recipeSection.matchAll(/```sh\n([\s\S]*?)```/g)].map(match=>match[1]);
const canary='synthetic previously retained backup';
const migrations=['001-current-revision-integrity.sql','002-create-idempotency.sql','003-membership-active.sql'];
function fixture(run){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memz backup proof '));
  for(const name of ['scripts','db/migrations','bin','backups','other-project'])fs.mkdirSync(path.join(dir,name),{recursive:true});
  fs.copyFileSync(path.join(root,script),path.join(dir,script));
  for(const name of ['compose.yml','db/schema.sql',...migrations.map(name=>'db/migrations/'+name)])fs.writeFileSync(path.join(dir,name),name+'\n');
  const previous=path.join(dir,'backups/previous.dump');fs.writeFileSync(previous,canary);
  const log=path.join(dir,'commands.log'),counter=path.join(dir,'psql-count'),observed=path.join(dir,'observed-variable'),migrationLog=path.join(dir,'migrations.log');
  fs.writeFileSync(path.join(dir,'bin/docker'),`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case " $* " in
  *' pg_dump '*)
    case "$FAKE_DUMP_MODE" in
      fail) printf 'synthetic partial dump'; printf 'synthetic-private-dump-error' >&2; exit 7 ;;
      empty) exit 0 ;;
      *) printf 'PGDMP synthetic fixture, not a real archive\\n'; exit 0 ;;
    esac ;;
  *' psql '*)
    cat >> "$FAKE_MIGRATION_LOG"
    count=0
    if [ -f "$FAKE_PSQL_COUNT" ]; then count=$(cat "$FAKE_PSQL_COUNT"); fi
    count=$((count+1)); printf '%s' "$count" > "$FAKE_PSQL_COUNT"
    if [ "$FAKE_MIGRATION_FAIL_AT" = "$count" ]; then exit 9; fi
    exit 0 ;;
esac
exit 8
`,{mode:0o700});
  const env={PATH:path.join(dir,'bin')+':/usr/bin:/bin',FAKE_LOG:log,FAKE_PSQL_COUNT:counter,FAKE_CAPTURE_VARIABLE:observed,FAKE_MIGRATION_LOG:migrationLog};
  const execute=(command,{cwd=dir,extra={}}={})=>{
    const result=spawnSync('/bin/sh',['-c',command],{cwd,env:{...env,...extra},encoding:'utf8',timeout:5000,maxBuffer:65536});
    assert.equal(result.error,undefined);assert.equal(result.signal,null);return result;
  };
  const commands=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n'):[];
  const applied=()=>fs.existsSync(migrationLog)?fs.readFileSync(migrationLog,'utf8').trim().split('\n'):[];
  try{return run({dir,previous,observed,execute,commands,applied})}finally{fs.rmSync(dir,{recursive:true,force:true})}
}
function documentedRecipe(){
  assert.equal(blocks.length,2,'backup and verified-migration phases must remain separate');
  return blocks.join('\n')+`\nmemz_recipe_status=$?\nprintf '%s' "\${memz_backup:-}" > "$FAKE_CAPTURE_VARIABLE"\nexit "$memz_recipe_status"\n`;
}
test('failed and empty dump cannot overwrite an older backup, leave partial owned files, or run migrations',()=>{
  for(const mode of ['fail','empty'])fixture(({dir,previous,observed,execute,commands})=>{
    const output=execute(documentedRecipe(),{extra:{FAKE_DUMP_MODE:mode,memz_backup:previous}});
    assert.notEqual(output.status,0);assert.equal(output.stdout,'');assert.ok(!output.stderr.includes('synthetic-private'));assert.equal(fs.readFileSync(previous,'utf8'),canary);
    assert.equal(fs.readFileSync(observed,'utf8'),'','failed assignment clears a stale backup variable');
    assert.equal(commands().filter(command=>command.includes('pg_dump')).length,1);assert.equal(commands().some(command=>command.includes('psql')),false);
    assert.deepEqual(fs.readdirSync(path.join(dir,'backups')),['previous.dump']);
  });
});
test('successful backups are unique private .dump paths and the helper itself never runs migration',()=>fixture(({dir,previous,execute,commands})=>{
  const paths=[];
  for(let i=0;i<2;i++){
    const output=execute('sh '+script);assert.equal(output.status,0);assert.equal(output.stderr,'');
    const file=output.stdout.trim();assert.equal(path.isAbsolute(file),true);assert.equal(file.endsWith('.dump'),true);assert.equal(file.startsWith(path.join(dir,'backups')+path.sep),true);
    assert.equal(fs.readFileSync(file,'utf8'),'PGDMP synthetic fixture, not a real archive\n');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);paths.push(file);
  }
  assert.notEqual(paths[0],paths[1]);assert.equal(fs.readFileSync(previous,'utf8'),canary);assert.equal(commands().length,2);assert.ok(commands().every(command=>command==='compose exec -T db pg_dump -U postgres -d memz -Fc'));
}));
test('each failed numbered migration short circuits the documented chain and retains new and previous backups',()=>{
  for(const failAt of [1,2,3])fixture(({previous,observed,execute,commands,applied})=>{
    const output=execute(documentedRecipe(),{extra:{FAKE_MIGRATION_FAIL_AT:String(failAt)}});assert.equal(output.status,9);
    assert.equal(commands().filter(command=>command.includes('psql')).length,failAt);assert.deepEqual(applied(),migrations.slice(0,failAt).map(name=>'db/migrations/'+name));
    assert.equal(fs.readFileSync(previous,'utf8'),canary);
    const file=fs.readFileSync(observed,'utf8');assert.equal(file.endsWith('.dump'),true);assert.ok(fs.statSync(file).size>0);
  });
});
test('migration preconditions reject a missing backup variable and the successful chain invokes numbered commands once',()=>{
  fixture(({execute,commands})=>{const output=execute(blocks[1]);assert.notEqual(output.status,0);assert.equal(commands().length,0)});
  fixture(({execute,commands,applied})=>{const output=execute(documentedRecipe());assert.equal(output.status,0);assert.equal(commands().filter(command=>command.includes('pg_dump')).length,1);assert.equal(commands().filter(command=>command.includes('psql')).length,3);assert.deepEqual(applied(),migrations.map(name=>'db/migrations/'+name))});
});
test('wrong cwd, missing root markers and extra arguments fail before invoking any Docker command',()=>{
  for(const mode of ['cwd','marker','arguments',...migrations])fixture(({dir,previous,execute,commands})=>{
    if(mode==='marker')fs.unlinkSync(path.join(dir,'compose.yml'));
    if(migrations.includes(mode))fs.unlinkSync(path.join(dir,'db/migrations',mode));
    const command=mode==='cwd'?'sh "'+path.join(dir,script)+'"':'sh '+script+(mode==='arguments'?' --unexpected':'');
    const output=execute(command,{cwd:mode==='cwd'?path.join(dir,'other-project'):dir});
    assert.notEqual(output.status,0);assert.equal(output.stdout,'');assert.equal(commands().length,0);assert.equal(fs.readFileSync(previous,'utf8'),canary);assert.deepEqual(fs.readdirSync(path.join(dir,'backups')),['previous.dump']);
  });
});
test('the material-package whitelist includes the shell helper and excludes backups and environment files',()=>{
  const source=fs.readFileSync(path.join(root,'scripts/package-evidence.js'),'utf8'),expression=source.match(/const include=file=>([^\n]+);/)[1];
  const include=vm.runInNewContext('(file)=>'+expression,{benchmarkSources:[]});
  assert.equal(include(script),true);assert.equal(include('docs/backup-recovery.md'),true);assert.equal(include('test/backup-before-migration.test.js'),true);
  assert.equal(include('backups/private.dump'),false);assert.equal(include('.env'),false);
});
