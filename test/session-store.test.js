const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SessionStore,SESSION_TTL_MS,MAX_SESSIONS}=require('../scripts/session-store');

test('session admission retains active users and rejects excess sessions',()=>{
  let now=1000;
  const store=new SessionStore({maxSessions:2,ttlMs:100,now:()=>now});
  assert.equal(store.create('first',{id:1,csrf:'first-csrf'}),true);
  now+=10;assert.equal(store.create('second',{id:2}),true);
  assert.equal(store.create('excess',{id:3}),false);
  assert.equal(store.get('excess'),undefined);
  assert.deepEqual(store.get('first'),{id:1,csrf:'first-csrf',expires:1100});
  assert.equal(store.get('second').id,2);
  assert.equal(store.create('excess',{id:3},{replaceToken:'forged'}),false);
  assert.equal(store.get('first').id,1);
});

test('new login reclaims expired sessions even when their cookies never return',()=>{
  let now=0;
  const store=new SessionStore({maxSessions:2,ttlMs:100,now:()=>now});
  store.create('orphan',{id:1});
  now=50;store.create('active',{id:2});
  now=100;
  assert.equal(store.create('new',{id:3}),true,'expiry boundary must free capacity');
  assert.equal(store.get('orphan'),undefined);
  assert.equal(store.get('active').id,2);
  assert.equal(store.get('new').expires,200);
  assert.equal(store.create('excess',{id:4}),false);
});

test('reads expire at the deadline without extending the lifetime',()=>{
  let now=0;
  const store=new SessionStore({maxSessions:1,now:()=>now});
  store.create('session',{id:1});
  now=SESSION_TTL_MS-1;assert.equal(store.get('session').expires,SESSION_TTL_MS);
  now=SESSION_TTL_MS;assert.equal(store.get('session'),undefined);
  assert.equal(store.create('next',{id:2}),true);
});

test('reauthentication replaces only the presented active session at capacity',()=>{
  const store=new SessionStore({maxSessions:2,now:()=>0});
  store.create('old',{id:1});store.create('other',{id:2});
  assert.equal(store.create('replacement',{id:3},{replaceToken:'old'}),true);
  assert.equal(store.get('old'),undefined);
  assert.equal(store.get('replacement').id,3);
  assert.equal(store.get('other').id,2);
  assert.equal(store.create('extra',{id:4}),false);
});

test('logout releases capacity and expired replacement tokens cannot bypass the bound',()=>{
  let now=0;
  const store=new SessionStore({maxSessions:1,ttlMs:100,now:()=>now});
  store.create('expired',{id:1});now=100;store.create('active',{id:2});
  assert.equal(store.create('bypass',{id:3},{replaceToken:'expired'}),false);
  assert.equal(store.delete('missing'),false);
  assert.equal(store.delete('active'),true);
  assert.equal(store.create('next',{id:3}),true);
});

test('default store enforces its finite session bound',()=>{
  const store=new SessionStore({now:()=>0});
  assert.equal(MAX_SESSIONS,1000);
  for(let i=0;i<MAX_SESSIONS;i++)assert.equal(store.create(String(i),{id:i}),true);
  assert.equal(store.create('excess',{id:MAX_SESSIONS}),false);
});
