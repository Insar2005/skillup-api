// Bot finance parser. All money in frontend RUB integer units (not minor units).
const expenseHints = [
  ['Продукты', /продукт|магазин|супермаркет|рынок|молоко|хлеб|овощ|фрукт|мясо|бакале|покупк.*ед/iu],
  ['Еда вне дома', /кафе|ресторан|обед|ужин|завтрак|кофе|пицц|шаурм|доставк.*ед/iu],
  ['Жилье', /жиль|аренд|квартир|коммунал|шкаф|ремонт|мебел|электричеств|интернет|диван/iu],
  ['Транспорт', /транспорт|бензин|заправ|такси|автобус|метро|парков|автомобил|машин|топлив/iu]
];
const words = {ноль:0,один:1,одна:1,два:2,две:2,три:3,четыре:4,пять:5,шесть:6,семь:7,восемь:8,девять:9,десять:10,одиннадцать:11,двенадцать:12,тринадцать:13,четырнадцать:14,пятнадцать:15,шестнадцать:16,семнадцать:17,восемнадцать:18,девятнадцать:19,двадцать:20,тридцать:30,сорок:40,пятьдесят:50,шестьдесят:60,семьдесят:70,восемьдесят:80,девяносто:90,сто:100,двести:200,триста:300,четыреста:400,пятьсот:500,шестьсот:600,семьсот:700,восемьсот:800,девятьсот:900};
export function extractAmount(text){
  const normalized=text.toLowerCase().replace(/\u00a0/g,' ');
  let m=normalized.match(/(?:^|\D)(\d[\d\s.,]*)(?:\s*)(тысяч[аиуы]?|тыс\.?|миллион[а-я]*|млн\.?)(?=\b|\s|$)/iu);
  if(m){const n=Number(m[1].replace(/[\s,]/g,''));if(!Number.isSafeInteger(n))return null;return n*(/миллион|млн/u.test(m[2])?1000000:1000);}
  m=normalized.match(/(?:^|\D)(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+)(?:\s*(?:₽|руб(?:лей|ля|ль)?|сом(?:ов|а)?))?/iu);
  if(m){const n=Number(m[1].replace(/[\s.,]/g,''));return Number.isSafeInteger(n)&&n>0?n:null;}
  const parts=normalized.replace(/[.,!?]/g,' ').split(/\s+/).filter(Boolean);
  let total=0,group=0,found=false;
  for(const part of parts){
    if(part in words){group+=words[part];found=true;continue;}
    if(/^тысяч/u.test(part)||part==='тыс'){total+=(group||1)*1000;group=0;found=true;continue;}
    if(/^миллион/u.test(part)||part==='млн'){total+=(group||1)*1000000;group=0;found=true;continue;}
    if(found)break;
  }
  return found && total+group>0 ? total+group : null;
}
export function classifyFinance(text){
  const t=String(text||'').toLowerCase().trim();
  if(t.includes('?')||/^(как|сколько|покажи|отч[её]т|какие|почему|что у меня)/iu.test(t))return null;
  const income=/(?:доход|заработал|получил|поступил|пришли|зарплат|аванс|выручк|продал|преми|возврат)/iu.test(t);
  const expense=/(?:расход|потратил|потратила|купил|купила|оплатил|оплатила|заплатил|заплатила|заправил|обедал|заказал)/iu.test(t);
  if(income===expense)return null;
  if(/(?:\bKGS\b|\bUSD\b|\bEUR\b|сом(?:ов|а)?|доллар|евро)/iu.test(t))return {unsupportedCurrency:true};
  const amount=extractAmount(t);
  if(!amount||!Number.isSafeInteger(amount)||amount>999999999999)return {needAmount:true,direction:income?'income':'expense'};
  const direction=income?'income':'expense';
  const category=income?(/зарплат|аванс|оклад/iu.test(t)?'Зарплата':'Прочие доходы'):(expenseHints.find(([,re])=>re.test(t))?.[0]||null);
  return {direction,amount,category,note:String(text).trim().slice(0,350)};
}
export const EXPENSE_CATEGORIES = expenseHints.map(x=>x[0]);
export const INCOME_CATEGORIES = ['Зарплата','Прочие доходы'];
