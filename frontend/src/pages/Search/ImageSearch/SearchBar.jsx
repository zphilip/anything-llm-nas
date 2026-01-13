import { useState, useRef, useEffect } from 'react';

export function SearchBar({ search }) {
    return (<form
        onSubmit={e => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const text = formData.get('text');
            search(text);
        }}
        className='relative mb-2'
    >
        <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
            <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20">
                <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 19-4-4m0-7A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z" />
            </svg>
        </div>
        <input
            type="search"
            name="text"
            id="default-search"
            className="block w-full p-4 pl-10 text-sm text-gray-900 border border-gray-300 rounded-lg bg-gray-50 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
            placeholder="Search for images..."
            required
        />
        <button
            type="submit"
            className="text-white absolute right-2.5 bottom-2.5 bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-4 py-2 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
        >
            Search
        </button>
    </form>)
}


export function SearchBarOption({ search, searchDistance, setSearchDistance, distanceOptions }) {
    const [query, setQuery] = useState("");
    const [showDropdown, setShowDropdown] = useState(false);
    const dropdownRef = useRef(null);
    
    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setShowDropdown(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        search(query);
    };

    return (
        <div className='relative mb-4'>
            <form onSubmit={handleSubmit} className='relative'>
                <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
                    <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20">
                        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m19 19-4-4m0-7A7 7 0 1 1 1 8a7 7 0 0 1 14 0Z" />
                    </svg>
                </div>
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onClick={() => setShowDropdown(true)}
                    className="block w-full p-4 pl-10 text-sm text-gray-900 border border-gray-300 rounded-lg bg-gray-50 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
                    placeholder="Search for images..."
                    required
                />
                <button
                    type="submit"
                    className="text-white absolute right-2.5 bottom-2.5 bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 font-medium rounded-lg text-sm px-4 py-2 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
                >
                    Search
                </button>
            </form>

            {/* Distance selector dropdown */}
            {showDropdown && (
                <div 
                    ref={dropdownRef}
                    className="absolute z-10 mt-1 w-full bg-white rounded-md shadow-lg dark:bg-gray-800 border border-gray-200 dark:border-gray-700"
                >
                    <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-600">
                        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Sort by distance metric</h3>
                    </div>
                    <div className="p-2">
                        {Object.entries(distanceOptions).map(([key, value]) => (
                            <button
                                key={value}
                                onClick={() => {
                                    setSearchDistance(value);
                                    setShowDropdown(false);
                                }}
                                className={`flex items-center w-full px-3 py-2 text-sm rounded-md transition-colors ${
                                    searchDistance === value
                                        ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
                                        : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                                }`}
                            >
                                <span className={`mr-2 w-2 h-2 rounded-full ${searchDistance === value ? "bg-blue-500" : "bg-gray-400"}`}></span>
                                {key.charAt(0) + key.slice(1).toLowerCase()}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Current sort display */}
            <div className="flex items-center mt-2 text-sm text-gray-500 dark:text-gray-400">
                <span>Sorting: </span>
                {Object.entries(distanceOptions).map(([key, value]) => (
                    searchDistance === value && (
                        <span key={value} className="ml-1 text-blue-500 font-medium">
                            {key.charAt(0) + key.slice(1).toLowerCase()}
                        </span>
                    )
                ))}
                <button 
                    onClick={() => setShowDropdown(!showDropdown)}
                    className="ml-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                >
                    Change
                </button>
            </div>
        </div>
    );
}