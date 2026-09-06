import { expect, test } from 'vitest'
import { sanitizeAuthValue } from '../src/lib/authStorage'
test('serialized auth session never retains recovery input',()=>{
 const result=JSON.parse(sanitizeAuthValue(JSON.stringify({access_token:'session-token',user:{user_metadata:{display_name:'Alice',recovery_answer:'secret',recovery_question:'question'}}})))
 expect(result.user.user_metadata).toEqual({display_name:'Alice'})
 expect(result.access_token).toBe('session-token')
})
