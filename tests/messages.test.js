import { expect, test } from 'vitest'
import { mergeMessages } from '../src/lib/messageState'
test('updates preserve older loaded pages and stable ordering',()=>{
 const a={id:'a',created_at:'2026-01-01',body:'old'},b={id:'b',created_at:'2026-01-02',body:'new'}
 const rows=mergeMessages([a,b],[{...b,body:'updated'}])
 expect(rows.map(m=>m.body)).toEqual(['old','updated'])
 expect(mergeMessages(rows,[b]).map(m=>m.id)).toEqual(['a','b'])
})
