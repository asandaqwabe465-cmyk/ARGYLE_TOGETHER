export const PRIVACY_VERSION='2026-10-11';
export const ESCORT_WAIT=20*60*1000;
export const LOCATION_TTL=2*60*1000;
export function canRequestEscort(trip:{created:number;status:string;departure:number},replyCount:number,now:number){return trip.status==='open'&&trip.departure>now&&now-trip.created>=ESCORT_WAIT&&replyCount===0}
export function validLocation(value:{lat:number;lng:number;accuracy:number;at:number},now:number){return Number.isFinite(value.lat)&&Number.isFinite(value.lng)&&Number.isFinite(value.accuracy)&&Number.isFinite(value.at)&&Math.abs(value.lat)<=90&&Math.abs(value.lng)<=180&&value.accuracy>=0&&value.accuracy<=100000&&value.at<=now+10000&&value.at>=now-LOCATION_TTL}
export function cleanEmail(value:unknown){return typeof value==='string'?value.trim().toLowerCase():''}
