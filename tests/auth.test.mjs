// Offline tests on the exact Telegram validator function from src/server.js.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const source = readFileSync(new URL('../src/server.js', import.meta.url),'utf8');
const start = source.indexOf('function rejectTelegram(');
const end = source.indexOf('\nasync function authenticatedUser(',start);
if(start<0 || end<0) throw Error('validator not found');
const TOKEN = '123456:LOCAL_TEST_FAKE_BOT_TOKEN';
const context = {crypto, process:{env:{TELEGRAM_BOT_TOKEN:TOKEN,AUTH_DIAGNOSTICS:'false'}}, URLSearchParams,Buffer,Date,Set,JSON,Number,Math,console};
const validate = vm.runInNewContext(source.slice(start,end)+'\nvalidateTelegram',context);
function sign(token,extra={}){
  const data = {auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:12345,first_name:'Test'}),...extra};
  const dcs = Object.entries(data).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256',secret).update(dcs).digest('hex');
  return new URLSearchParams({...data,hash}).toString();
}
function check(name,yes){console.log((yes?'PASS ':'FAIL ')+name);if(!yes)process.exitCode=1;}
const bare=sign(TOKEN), withSignature=sign(TOKEN,{signature:'signed-example-field'});
check('valid initData without signature',!!validate(bare));
check('valid initData WITH signature',!!validate(withSignature));
check('tampered signature rejected',validate(withSignature.replace('signed-example-field','tampered-example-field'))===null);
check('wrong bot token rejected',validate(sign('99999:WRONG_TOKEN'))===null);
check('empty initData rejected',validate('')===null);
check('tampered user rejected',validate(bare.replace('Test','Attacker'))===null);
check('expired initData rejected',validate(sign(TOKEN,{auth_date:String(Math.floor(Date.now()/1000)-90000)}))===null);
check('duplicate field rejected',validate(bare+'&auth_date=0')===null);
check('future auth date rejected',validate(sign(TOKEN,{auth_date:String(Math.floor(Date.now()/1000)+120)}))===null);
