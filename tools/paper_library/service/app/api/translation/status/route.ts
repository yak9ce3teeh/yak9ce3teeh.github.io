import {reply,secret} from '../../../../lib/translation';
export async function GET(request:Request){return reply(request,{configured:!!secret(),model:'deepseek-flash',runtime:'cloud',requiresZotero:false});}
