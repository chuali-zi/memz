const SESSION_TTL_MS=8*3600000;
const MAX_SESSIONS=1000;

// Single-process demo sessions. Admission never evicts an active login, and
// pruning on creation bounds retained expired entries without a background timer.
class SessionStore{
  #sessions=new Map();
  constructor({maxSessions=MAX_SESSIONS,ttlMs=SESSION_TTL_MS,now=Date.now}={}){
    if(!Number.isSafeInteger(maxSessions)||maxSessions<1)throw new TypeError('Invalid session capacity');
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new TypeError('Invalid session lifetime');
    if(typeof now!=='function')throw new TypeError('Invalid session clock');
    this.maxSessions=maxSessions;this.ttlMs=ttlMs;this.now=now;
  }
  get(token){
    const session=this.#sessions.get(token);
    if(session&&session.expires<=this.now()){this.#sessions.delete(token);return undefined}
    return session;
  }
  create(token,user,{replaceToken}={}){
    const now=this.now();
    for(const [key,session] of this.#sessions)if(session.expires<=now)this.#sessions.delete(key);
    if(this.#sessions.size>=this.maxSessions&&!this.#sessions.has(replaceToken))return false;
    this.#sessions.set(token,{...user,expires:now+this.ttlMs});
    if(replaceToken!==token)this.#sessions.delete(replaceToken);
    return true;
  }
  delete(token){return this.#sessions.delete(token)}
}

module.exports={SessionStore,SESSION_TTL_MS,MAX_SESSIONS};
