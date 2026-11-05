import test from 'node:test';import assert from 'node:assert/strict';
import {extractAmount,classifyFinance} from '../src/bot-finance.js';
import {validWebhookSecret} from '../src/bot.js';
test('money wordforms and categories',()=>{
 assert.equal(extractAmount('сорок тысяч'),40000);
 assert.equal(extractAmount('40 тысяч'),40000);
 assert.equal(extractAmount('1 250 рублей'),1250);
 assert.deepEqual([classifyFinance('купил шкаф за 15000')?.amount,classifyFinance('купил шкаф за 15000')?.category],[15000,'Жилье']);
 assert.deepEqual([classifyFinance('получил зарплату 45000')?.direction,classifyFinance('получил зарплату 45000')?.category],['income','Зарплата']);
 assert.equal(classifyFinance('продал телефон за 40 тысяч').category,'Прочие доходы');
 assert.equal(classifyFinance('купил кофе за 150 сом').unsupportedCurrency,true);
 assert.equal(classifyFinance('как мой прогресс за 7 дней'),null);
});
test('secret verification fails closed',()=>{
 assert.equal(validWebhookSecret('S3cret-09','S3cret-09'),true);
 assert.equal(validWebhookSecret('secret','S3cret-09'),false);
 assert.equal(validWebhookSecret(null,'S3cret-09'),false);
 assert.equal(validWebhookSecret('',''),false);
});
