import json, pathlib, subprocess, tempfile, uuid, hashlib, stat, time
root=pathlib.Path('/workspace/memz'); tmp=pathlib.Path(tempfile.mkdtemp(prefix='memz-backup-live-'))
project='memz_backup_'+uuid.uuid4().hex[:16]; cfg=tmp/'compose.json'
cfg.write_text(json.dumps({'services':{'db':{'image':'postgres:16','pull_policy':'never','environment':{'POSTGRES_PASSWORD':'postgres_demo_only','POSTGRES_DB':'memz'},'volumes':['data:/var/lib/postgresql/data'],'healthcheck':{'test':['CMD-SHELL','pg_isready -U postgres -d memz'],'interval':'1s','timeout':'1s','retries':30}}},'volumes':{'data':{}}}))
prefix=['env','COMPOSE_FILE='+str(cfg),'COMPOSE_PROJECT_NAME='+project]
compose=prefix+['docker','compose']; report={'synthetic':True,'modelCalls':0,'helperSha256':hashlib.sha256((root/'scripts/backup-before-migration.sh').read_bytes()).hexdigest(),'realPostgres':True,'noHostPorts':True}; attempted=False; backup=None; driver_bytes=0

def run(cmd, data=None, timeout=40):
 global driver_bytes
 p=subprocess.run(cmd,input=data,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 driver_bytes+=len(p.stdout)
 if len(p.stdout)>2*1024*1024 or driver_bytes>16*1024*1024: raise RuntimeError('bounded_output_exceeded')
 if p.returncode:
  report['failedCommand']=next((v for v in ['pg_restore','pg_dump','createdb','psql','up','down'] if v in cmd),'other')
  report['exitCode']=p.returncode
  message=p.stderr.decode(errors='replace').lower()
  report['diagnosticMarkers']=[v for v in ['transaction_timeout','already exists','does not exist','permission denied','connection','role','schema','version','unsupported','invalid','unrecognized','errors ignored','restrict','unrestrict','command not found'] if v in message]
  report['stderrBytes']=len(p.stderr)
  raise RuntimeError('command_failed_'+str(p.returncode))
 return p.stdout

def sql(database, query): return run(compose+['exec','-T','db','psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-t','-A'],query.encode())
try:
 assert not run(compose+['ps','-q']).strip(); attempted=True
 run(compose+['up','-d','--wait','--wait-timeout','30','db'])
 sql('memz',(root/'db/schema.sql').read_text())
 backup=pathlib.Path(run(prefix+['sh','scripts/backup-before-migration.sh']).decode().strip())
 assert backup.parent.parent.resolve()==(root/'backups').resolve() and backup.name=='memz.dump' and backup.parent.name.startswith('before-001.')
 assert backup.is_file() and 0<backup.stat().st_size<16*1024*1024
 report.update(backupBytes=backup.stat().st_size,backupMode=oct(stat.S_IMODE(backup.stat().st_mode)),directoryMode=oct(stat.S_IMODE(backup.parent.stat().st_mode)),backupSha256=hashlib.sha256(backup.read_bytes()).hexdigest())
 assert report['backupMode']=='0o600' and report['directoryMode']=='0o700'
 run(compose+['exec','-T','db','createdb','-U','postgres','memz_restored'])
 run(compose+['exec','-T','db','pg_restore','--exit-on-error','--single-transaction','--no-owner','-U','postgres','-d','memz_restored'],backup.read_bytes())
 report['restoreToolSucceeded']=True
 tables=['projects','memberships','sources','facts','candidates','revisions','audit','idempotency_requests']
 fingerprints={}
 for table in tables:
  query="SELECT count(*)::int,md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) FROM "+table+" t;"
  source=sql('memz',query); restored=sql('memz_restored',query); assert source==restored
  fingerprints[table]=source.decode().strip()
 catalog="SELECT 'policy',tablename,policyname,roles::text,cmd,qual::text,with_check::text FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname;"
 assert sql('memz',catalog)==sql('memz_restored',catalog)
 report.update(status='passed',tablesCompared=len(tables),rowFingerprints=fingerprints,rlsPoliciesEqual=True,toolVersions={name:run(compose+['exec','-T','db',name,'--version']).decode().strip() for name in ['pg_dump','pg_restore']})
except Exception as e:
 report.update(status='failed',error=type(e).__name__)
finally:
 if backup is not None:
  try: backup.unlink(); backup.parent.rmdir(); report['ownedBackupRemoved']=True
  except Exception: report['ownedBackupRemoved']=False
 if attempted:
  try: run(compose+['down','--volumes','--remove-orphans']); report['ownedComposeRemoved']=not bool(run(compose+['ps','-aq']).strip())
  except Exception: report['ownedComposeRemoved']=False
 report['driverOutputBytes']=driver_bytes
 (tmp/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({'report':str(tmp/'report.json'),**report}))
 if report.get('status')!='passed' or not report.get('ownedComposeRemoved') or not report.get('ownedBackupRemoved'): raise SystemExit(1)
