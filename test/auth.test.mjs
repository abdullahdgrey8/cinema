import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cinema} from './helpers.mjs';

for(const authCookieName of ['SID','QBT_SID_8080'])for(const authStatus of [200,204]){
  test(`qBittorrent authenticates with ${authCookieName} and HTTP ${authStatus}, then renews an expired session`,async t=>{
    const c=await cinema(t,{
      authCookieName,authStatus,
      authExtraCookies:['Theme=dark; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/'],
    });
    const plugins=await c.api('/api/plugins');assert.equal(plugins.length,4);
    const authenticated=c.state.requests.filter(r=>r.endpoint==='search/plugins');
    assert.ok(authenticated.length>=1);
    assert.ok(authenticated.every(r=>r.headers.cookie===authCookieName+'=test'),'Only qBittorrent authentication cookies should be forwarded');
    const loginsBefore=c.state.requests.filter(r=>r.endpoint==='auth/login').length;
    assert.equal(loginsBefore,1,'Parallel startup requests should share the login');
    c.state.authCookieValue='renewed';
    const recovered=await c.api('/api/plugins');assert.equal(recovered.length,4);
    assert.equal(c.state.requests.filter(r=>r.endpoint==='auth/login').length,loginsBefore+1);
    assert.equal(c.state.requests.filter(r=>r.endpoint==='search/plugins').at(-1).headers.cookie,authCookieName+'=renewed');
  });
}
