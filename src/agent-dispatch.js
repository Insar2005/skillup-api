// SkillUp v29.7: ONE deterministic action gateway shared by Telegram and Mini App.
// The LLM cannot claim mutations: only a committed database operation produces a success receipt.
import {executeAgentAction} from './agent-actions.js';
import {handleDevelopmentText} from './development-actions.js';
import {financeCorrectionIntent,restoreLastFinance,restoredFinanceReply,parseFinanceIntent,appendFinance,financeReply} from './ai-finance.js';
import {enrichFinanceCategory} from './category.js';

export const AGENT_CAPABILITIES=Object.freeze({
  finance:['create_transaction','correct_transaction','undo_transaction','restore_transaction','categorize_transaction'],
  development:['create_area','create_item','rename_area','rename_item','delete_goal','restore_goal','read_progress'],
  media:['read_receipt','transcribe_voice'],
  reminders:[],
});
export async function dispatchSkillUpAction({pool,user,text,key,timezone='Asia/Bishkek'}){
  const cmd=String(text||'').trim();
  if(!cmd||cmd.length>1500)return null;
  const direct=await executeAgentAction(pool,user,cmd,{key,timezone});
  if(direct)return {kind:'agent',answer:direct.text,changed:direct.changed||null,committed:true};
  const dev=await handleDevelopmentText(pool,user,cmd);
  if(dev)return {kind:'development',answer:dev.text,changed:dev.deleted||dev.restored?'development':null,pending:dev.pending||null,archiveId:dev.archiveId||null,committed:!!(dev.deleted||dev.restored)};
  if(financeCorrectionIntent(cmd)==='restore'){
    const restored=await restoreLastFinance(pool,user);
    return {kind:'restore',answer:restored?restoredFinanceReply(restored.entry):'Нет отменённой операции за последние 24 часа, которую можно восстановить.',restored:restored||null,changed:restored?'finances':null,committed:!!restored};
  }
  const tx=parseFinanceIntent(cmd,user.preferred_currency||'RUB');
  if(tx){
    const enriched=await enrichFinanceCategory(tx,cmd);
    const saved=await appendFinance(pool,user,[enriched],key,key.startsWith('bot:')?'telegram_bot':'chat');
    return {kind:'finance',answer:saved.added?financeReply(enriched,saved.entries):'Операция уже обработана. Повторно не записывал.',changed:saved.added?'finances':null,committed:!!saved.added};
  }
  return null;
}
