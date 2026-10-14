import {render,screen} from '@testing-library/react'
import {describe,expect,it,vi} from 'vitest'
import {NARRATOR_PINS} from '../speech/local/narratorAssets'
import {LocalNarratorNotices} from './LocalNarratorNotices'
describe('voice licences',()=>{
 it('offers legal access without pre-consent requests or technical panel copy',()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');render(<LocalNarratorNotices/>);
  expect(screen.getByRole('link',{name:'Licences'})).toHaveAttribute('href','http://localhost/voice/notices/index.html');expect(fetcher).not.toHaveBeenCalled();fetcher.mockRestore();
  expect(document.body.textContent).not.toMatch(/eSpeak|GPL|commit|source archive/)
 });
 it('matches the accepted frontend',()=>{expect(NARRATOR_PINS.phonemizer.project).toBe('hexgrad/misaki');expect(NARRATOR_PINS.phonemizer.licence).toBe('Apache-2.0')})
})
