import {json} from '../../../lib/cloud';
export async function GET(){return json({model:'Xenova/all-MiniLM-L6-v2',runtime:'browser',outputs:['category','keywords'],module:'/classification.mjs',paidFallback:false});}
