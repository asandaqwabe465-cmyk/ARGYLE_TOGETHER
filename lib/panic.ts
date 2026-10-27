export function panicCoordinates(value:any,now:number){
 if(!value||!Number.isFinite(value.lat)||!Number.isFinite(value.lng)||!Number.isFinite(value.accuracy)||!Number.isFinite(value.at)||Math.abs(value.lat)>90||Math.abs(value.lng)>180||value.accuracy<0||value.at>now+10000||value.at<now-86400000)return null;
 return {lat:value.lat,lng:value.lng,accuracy:value.accuracy,at:value.at};
}
