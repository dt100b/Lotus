import assert from 'node:assert/strict'
import {retainFrontExpiryIv} from '../src/data/listedExpiryRetention.ts'

const now=1_000_000
const front={expiryTsMs:now+3_600_000,dteDays:1/24,status:'ok',atmIvPercent:39.12,
  forwardUsd:82817,lowerStrike:82500,upperStrike:83000,reasons:[]}
const back={...front,expiryTsMs:now+86_400_000,dteDays:1,atmIvPercent:37.4}
const first=retainFrontExpiryIv([front,back],null,now)
assert.equal(first.front,front)
const rejected={...front,dteDays:.03,status:'unavailable',atmIvPercent:null,reasons:['atm_not_bracketed']}
const failedBack={...back,status:'unavailable',atmIvPercent:null}
let retained=retainFrontExpiryIv([rejected,failedBack],first.front,now+60_000)
assert.equal(retained.rows[0].atmIvPercent,39.12)
assert.equal(retained.rows[0].dteDays,.03,'DTE must advance while IV is held')
assert.equal(retained.rows[1],failedBack,'Only the front expiry is held')
retained=retainFrontExpiryIv([rejected,back],retained.front,now+600_000)
assert.equal(retained.rows[0].atmIvPercent,39.12,'Continue holding until quotes pass again')
const updated={...front,atmIvPercent:40.25}
retained=retainFrontExpiryIv([updated,back],retained.front,now+660_000)
assert.equal(retained.front,updated,'The next valid observation replaces the held value')
assert.equal(retained.rows[0].atmIvPercent,40.25)
assert.equal(retainFrontExpiryIv([rejected,back],null,now).rows[0].atmIvPercent,null,'Cannot manufacture a first valid point')
assert.equal(retainFrontExpiryIv([{...rejected,expiryTsMs:back.expiryTsMs}],retained.front,now).front,null,'No carryover across contracts')
assert.equal(retainFrontExpiryIv([rejected,back],retained.front,front.expiryTsMs).front,null,'Stop retaining at settlement')
assert.equal(retainFrontExpiryIv([],retained.front,now).front,null,'Clear cache when the source is removed')
assert.equal(rejected.atmIvPercent,null,'Do not overwrite source validation results')
console.log('PASS: front-only retention, repeated rejection, advancing DTE, recovery, settlement/rollover, source isolation')
