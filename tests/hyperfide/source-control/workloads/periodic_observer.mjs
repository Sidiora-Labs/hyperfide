export class PeriodicObserver {
 constructor(observe,onError){this.observe=observe;this.onError=onError;this.tail=Promise.resolve();this.timer=null;this.stopped=false;this.started=false;this.failure=null;}
 sample(phase){
  if(this.stopped)return Promise.reject(new Error('Observer has stopped'));
  const result=this.tail.then(()=>{if(this.failure)throw this.failure;return this.observe(phase);});
  this.tail=result.catch(error=>{if(!this.failure){this.failure=error;try{this.onError(error);}catch(callbackError){this.failure=callbackError;}}});
  return result;
 }
 start(interval){
  if(this.started||this.stopped||!Number.isSafeInteger(interval)||interval<1)throw new Error('Observer requires one positive interval');
  this.started=true;
  const tick=async()=>{if(this.stopped)return;try{await this.sample('periodic');}catch{return;}if(!this.stopped)this.timer=setTimeout(tick,interval);};
  this.timer=setTimeout(tick,interval);
 }
 async stop(){this.stopped=true;clearTimeout(this.timer);await this.tail;if(this.failure)throw this.failure;}
}
export function observationCoverage(start,end,timestamps,maximumGap){
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||!Number.isFinite(maximumGap)||maximumGap<=0)throw new Error('Invalid observation window');
 const inside=timestamps.filter(value=>Number.isFinite(value)&&value>=start&&value<=end).sort((a,b)=>a-b);
 if(!inside.length)throw new Error('No periodic observation inside workload window');
 const points=[start,...inside,end];let maximum=0;
 for(let index=1;index<points.length;index++)maximum=Math.max(maximum,points[index]-points[index-1]);
 if(maximum>maximumGap)throw new Error('Periodic observation coverage gap exceeds declared bound: '+maximum);
 return {samples:inside.length,maximum_gap_ms:maximum,allowed_gap_ms:maximumGap};
}
