import { useParams } from 'react-router-dom';
import { ComingSoon } from '../components/ComingSoon';

export function NodeDetail() {
  const { id } = useParams();
  return <ComingSoon title={id ?? 'Node'} subtitle="Node detail: history merged with the live stream" task="B5" />;
}
