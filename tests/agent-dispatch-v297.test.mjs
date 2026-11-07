import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFinanceIntent} from '../src/ai-finance.js';
import {localExpenseCategory} from '../src/category.js';
import {AGENT_CAPABILITIES,dispatchSkillUpAction} from '../src/agent-dispatch.js';
test('short expense without verb is captured',()=>{
 const result=parseFinanceIntent('393 сом за доставку резисторов','RUB');
 assert.equal(result?.amount,393);
 assert.equal(result?.currency,'KGS');
 assert.equal(result?.type,'Расход');
 assert.equal(localExpenseCategory(result.note),'Доставка');
});
test('similar question does not become expense',()=>{
 assert.equal(parseFinanceIntent('393 сом за доставку резисторов?','KGS'),null);
});
test('clear contextual categories',()=>{
 assert.equal(localExpenseCategory('Купил чай в магазине'),'Продукты');
 assert.equal(localExpenseCategory('Выпил чай в кафе'),'Еда вне дома');
 assert.equal(localExpenseCategory('Купил Starlink'),'Электроника');
 assert.equal(localExpenseCategory('Доставка пиццы'),'Еда вне дома');
});
test('catalog identifies separate server tools',()=>{
 assert.ok(AGENT_CAPABILITIES.finance.includes('restore_transaction'));
 assert.ok(AGENT_CAPABILITIES.development.includes('delete_goal'));
 assert.equal(AGENT_CAPABILITIES.reminders.length,0);
});
test('empty input calls no mutations',async()=>{
 assert.equal(await dispatchSkillUpAction({pool:null,user:null,text:'',key:'chat:fake'}),null);
});
