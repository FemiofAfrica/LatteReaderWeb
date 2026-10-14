import { NARRATOR_PINS, narratorPath } from '../speech/local/narratorAssets'
/** Legal details stay accessible without a pre-consent download. */
export function LocalNarratorNotices({ origin = window.location.origin }: { origin?: string }) {
 return <p className="panel-copy" data-local-notices="ready"><a href={narratorPath(NARRATOR_PINS.phonemizer.noticeIndex, origin)}>Licences</a></p>
}
