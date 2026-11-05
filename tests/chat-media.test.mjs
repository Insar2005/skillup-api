import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFinanceIntent} from '../src/ai-finance.js';
import {validateReceiptCandidate} from '../src/ai-media.js';
test('finance: clear intent, default and explicit currency',()=>{
 const x=parseFinanceIntent('Купил iPad за 1000','KGS');assert.equal(x?.category,'Гаджеты');assert.equal(x?.amount,1000);assert.equal(x?.currency,'KGS');
 assert.equal(parseFinanceIntent('Потратил 185 сомов на сигареты','RUB')?.currency,'KGS');
 assert.equal(parseFinanceIntent('Получил зарплату 50 тысяч рублей','KGS')?.type,'Доход');
 assert.equal(parseFinanceIntent('Сколько потратил за неделю?','KGS'),null);
});
test('receipt validation: accurate item reconciliation and fallback total',()=>{
 const a=validateReceiptCandidate({kind:'receipt',currency:'KGS',total:300,items:[{name:'Хлеб',amount:100,category:'Продукты'},{name:'Молоко',amount:200,category:'Продукты'}]});
 assert.equal(a.items.length,2);assert.equal(a.reconciled,true);
 const b=validateReceiptCandidate({kind:'receipt',currency:'RUB',total:350,items:[{name:'Хлеб',amount:100,category:'Продукты'},{name:'Молоко',amount:200,category:'Продукты'}]});
 assert.equal(b.items.length,1);assert.equal(b.items[0].amount,350);
 assert.equal(validateReceiptCandidate({kind:'other',answer:'нет'}),null);
});
test('refund receipt becomes income',()=>{
 const a=validateReceiptCandidate({kind:'receipt',currency:'USD',direction:'income',total:10,items:[{name:'Возврат',amount:10,category:'Прочие доходы'}]});
 assert.equal(a.direction,'income');
});
