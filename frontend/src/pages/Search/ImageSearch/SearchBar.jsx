import { useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { DistanceSelector } from "./DistanceSelector";

export function SearchBar({ search, searchDistance, setSearchDistance, distanceOptions }) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      search(query);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-3 mb-6 items-center"
    >
      <div className="flex-1 relative">
        <MagnifyingGlass
          size={20}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50"
          weight="bold"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search images by description..."
          className="w-full pl-10 pr-4 py-3 rounded-lg bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder border border-white/10 focus:outline-primary-button focus:border-primary-button"
          autoFocus
        />
      </div>
      <DistanceSelector
        value={searchDistance}
        onChange={setSearchDistance}
        distanceOptions={distanceOptions}
      />
      <button
        type="submit"
        disabled={!query.trim()}
        className="px-6 py-3 rounded-lg bg-primary-button text-white font-medium hover:bg-primary-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Search
      </button>
    </form>
  );
}

export function SearchBarOption({ search, searchDistance, setSearchDistance, distanceOptions }) {
  return (
    <SearchBar
      search={search}
      searchDistance={searchDistance}
      setSearchDistance={setSearchDistance}
      distanceOptions={distanceOptions}
    />
  );
}
