import { NARRATOR_PINS, narratorPath } from '../speech/local/narratorAssets'

const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * Appropriate legal notices for the speech component the local narrator loads:
 * the licence, the modification record and the corresponding-source offer, all
 * served from this origin next to the object code (GPLv3 section 6(d)).
 *
 * Rendered from the pinned values the app already carries, so opening the local
 * engine makes no request at all: before the user presses Enable, nothing about
 * the narrator is fetched, not even this page.
 */
export function LocalNarratorNotices({ origin = window.location.origin }: { origin?: string }) {
  const { phonemizer } = NARRATOR_PINS
  return <p className="panel-copy" data-local-notices="ready" data-local-component={phonemizer.project}>
    Speech component: eSpeak-NG {phonemizer.tag}, {phonemizer.licence}, no warranty. Built from commit {phonemizer.commit.slice(0, 8)}, modified {phonemizer.modified}.{' '}
    <a href={narratorPath(phonemizer.noticeIndex, origin)}>Licences and notices</a>{' · '}
    <a href={narratorPath(phonemizer.source.offer, origin)}>Corresponding source</a>{' · '}
    <a href={narratorPath(phonemizer.source.file, origin)} download>Source archive ({size(phonemizer.source.bytes)})</a>.
  </p>
}
