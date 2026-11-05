import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentAction} from '../src/agent-actions.js';
const cases=[
 ['Переименуй цель Relax в Заниматься спортом','rename'],
 ['Создай цель Бегать по утрам','create'],
 ['Поменяй сумму последнего расхода на 850','finance_amount'],
 ['Измени дату последнего расхода на вчера','finance_date'],
 ['Измени категорию последнего расхода на Продукты','finance_category'],
 ['Измени описание последней покупки на Чай','finance_note'],
 ['Отмени последнее изменение','undo']
];
for(const [value,expected] of cases)test(value,()=>assert.equal(parseAgentAction(value)?.type,expected));
for(const value of ['Не меняй цель Relax','Как переименовать цель Relax?','Удали все цели','Сотри все операции'])test(`Rejected: ${value}`,()=>assert.equal(parseAgentAction(value),null));
test('Expense targeting is narrow',()=>assert.equal(parseAgentAction('Поменяй сумму последнего расхода на 850')?.expenseOnly,true));
