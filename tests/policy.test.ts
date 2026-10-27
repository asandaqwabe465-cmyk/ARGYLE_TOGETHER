import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canRequestEscort,validLocation,LOCATION_TTL} from '../lib/policy.ts';
test('escort opens at exactly 20 minutes, only while open and without replies',()=>{const n=2000000;const t={created:n-1200000,status:'open',departure:n+1000};assert.equal(canRequestEscort(t,0,n-1),false);assert.equal(canRequestEscort(t,0,n),true);assert.equal(canRequestEscort(t,1,n),false);assert.equal(canRequestEscort({...t,status:'active'},0,n),false);assert.equal(canRequestEscort({...t,departure:n},0,n),false)});
test('reject stale, future and malformed GPS readings',()=>{const n=2000000,g={lat:-26.2,lng:28.04,accuracy:15,at:n};assert.equal(validLocation(g,n),true);for(const override of [{lat:91},{lng:181},{accuracy:-1},{lat:NaN},{at:n-LOCATION_TTL-1},{at:n+10001}])assert.equal(validLocation({...g,...override},n),false)});
