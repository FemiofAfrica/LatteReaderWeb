import { useEffect, useState } from 'react'
import { loadVoiceManifest, manifestPath, type VoiceBuildManifest } from '../speech/local/assetManifest'

const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * Appropriate legal notices for the speech component the local narrator loads:
 * the licence, the modification record and the corresponding-source offer, all
 * served from this origin next to the object code (GPLv3 section 6(d)).
 */
export function LocalNarratorNotices() {
  const [manifest, setManifest] = useState<VoiceBuildManifest | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let active = true
    loadVoiceManifest()
      .then(loaded => { if (active) setManifest(loaded) })
      .catch(() => { if (active) setMissing(true) })
    return () => { active = false }
  }, [])
  if (missing) return <p className="panel-copy" data-local-notices="unavailable" role="status">Licence and source information could not be loaded.</p>
  if (!manifest) return <p className="panel-copy" data-local-notices="loading" role="status">Loading licence and source information.</p>
  return <p className="panel-copy" data-local-notices="ready" data-local-component={manifest.upstream.project}>
    Speech component: eSpeak-NG {manifest.upstream.tag}, {manifest.upstream.licence}, no warranty. Built from commit {manifest.upstream.commit.slice(0, 8)}, modified {manifest.modifications.date}.{' '}
    <a href={manifestPath(manifest.noticeIndex)}>Licences and notices</a>{' · '}
    <a href={manifestPath(manifest.correspondingSource.offer)}>Corresponding source</a>{' · '}
    <a href={manifestPath(manifest.correspondingSource.file)} download>Source archive ({size(manifest.correspondingSource.bytes)})</a>.
  </p>
}
