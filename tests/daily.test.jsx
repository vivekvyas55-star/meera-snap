import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
const mocks=vi.hoisted(()=>({prompt:vi.fn(),answers:vi.fn(),status:vi.fn(),answer:vi.fn(),toast:vi.fn()}))
vi.mock('../src/lib/db',()=>({getTodaysPrompt:mocks.prompt,listPromptAnswers:mocks.answers,getPromptStatus:mocks.status,answerPrompt:mocks.answer,istToday:()=> '2026-09-06'}))
vi.mock('../src/hooks/useToast',()=>({useToast:()=>mocks.toast}))
import DailyQuestion from '../src/components/DailyQuestion'
afterEach(()=>{cleanup();vi.clearAllMocks()})
test('focus refresh reveals a friend answer arriving after mine',async()=>{
 mocks.prompt.mockResolvedValue({id:1,body:'Question',on_date:'2026-09-06'});mocks.status.mockResolvedValue({mine_done:true,theirs_done:false});mocks.answers.mockResolvedValue({mine:{body:'mine'},theirs:null})
 render(<DailyQuestion me="me" friend={{id:'friend'}} friendName="Friend"/> )
 await waitFor(()=>expect(screen.getByText('Answered · waiting for Friend')).toBeTruthy())
 mocks.answers.mockResolvedValue({mine:{body:'mine'},theirs:{body:'theirs'}})
 await act(async()=>{window.dispatchEvent(new Event('focus'))})
 await waitFor(()=>expect(screen.getByText('Today’s question — you both answered')).toBeTruthy())
})
test('yesterday’s prompt cannot be submitted as today',async()=>{
 mocks.prompt.mockResolvedValue({id:1,body:'Yesterday',on_date:'2026-09-05'});mocks.status.mockResolvedValue({});mocks.answers.mockResolvedValue({mine:null,theirs:null})
 render(<DailyQuestion me="me" friend={{id:'friend'}} friendName="Friend"/> )
 fireEvent.click(await screen.findByText('Question of the day'))
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'draft'}})
 mocks.prompt.mockResolvedValue({id:2,body:'Today',on_date:'2026-09-06'})
 fireEvent.submit(screen.getByRole('textbox').closest('form'))
 await waitFor(()=>expect(screen.getByText('Today')).toBeTruthy())
 expect(mocks.answer).not.toHaveBeenCalled()
 expect(screen.getByRole('textbox').value).toBe('draft')
 expect(screen.getByRole('button',{name:'Answer'}).disabled).toBe(true)
})
