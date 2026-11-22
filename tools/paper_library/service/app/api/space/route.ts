import {json} from '../../../lib/cloud';
import {bucketUsage} from '../../../lib/storage-usage';
// Space identity and aggregate PDF storage are public, like the catalog and PDFs.
// Owner credentials, account balances, database details and translation usage stay private.
let cached:Promise<any>|undefined,expires=0;
export async function GET(){
 if(!cached||Date.now()>=expires){
  cached=(async()=>{let r2;try{r2=await bucketUsage('pdf/');}catch{r2={unknown:'Storage measurement unavailable'};}
   return {name:"Yak9Ce3teeh's cloud space",provider:'Cloudflare R2',visibility:'public',scope:'Public paper-library storage only',sampledAt:new Date().toISOString(),r2,referenceBytes:10e9,referenceShared:true};
  })();expires=Date.now()+60000;
 }
 return json(await cached);
}
