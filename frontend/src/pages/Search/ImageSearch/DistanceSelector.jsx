export function DistanceSelector({ value, onChange, distanceOptions }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-4 py-2 rounded-lg bg-theme-settings-input-bg text-white border border-white/10 focus:outline-primary-button"
    >
      <option value={distanceOptions.EUCLIDEAN}>Euclidean (L2)</option>
      <option value={distanceOptions.COSINE}>Cosine Similarity</option>
      <option value={distanceOptions.DOT}>Dot Product</option>
    </select>
  );
}
