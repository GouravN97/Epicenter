import { useParams } from 'react-router-dom';
import { ComingSoon } from '../components/ComingSoon';

export function IncidentRoom() {
  const { id } = useParams();
  return <ComingSoon title={`Incident ${id ?? ''}`} subtitle="Replay, timeline and war room" task="B7" />;
}
