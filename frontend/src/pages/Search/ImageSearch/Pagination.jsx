import React from 'react';

export function Pagination({ 
  currentPage, 
  totalPages, 
  onPageChange, 
  itemsPerPage, 
  onItemsPerPageChange,
  totalItems 
}) {
  // Options for items per page dropdown
  const itemsPerPageOptions = [10, 20, 50, 100];
  
  // Generate array of page numbers to display
  const getPageNumbers = () => {
    const pageNumbers = [];
    
    // Always show first page
    pageNumbers.push(1);
    
    // Add current page and surrounding pages
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
      if (pageNumbers[pageNumbers.length - 1] !== i - 1) {
        // Add ellipsis if there's a gap
        pageNumbers.push('...');
      }
      pageNumbers.push(i);
    }
    
    // Add last page if needed
    if (totalPages > 1) {
      if (pageNumbers[pageNumbers.length - 1] !== totalPages - 1) {
        // Add ellipsis if there's a gap
        pageNumbers.push('...');
      }
      pageNumbers.push(totalPages);
    }
    
    return pageNumbers;
  };

  return (
    <div className="flex flex-wrap items-center justify-between py-4 px-2 mt-4 bg-gray-900 rounded-lg">
      <div className="flex items-center space-x-2 text-white mb-2 md:mb-0">
        <span>Show:</span>
        <select 
          value={itemsPerPage}
          onChange={(e) => onItemsPerPageChange(e.target.value)}
          className="bg-gray-800 text-white rounded px-2 py-1 border border-gray-700"
        >
          {itemsPerPageOptions.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <span>per page</span>
        <span className="ml-4">
          Showing {Math.min((currentPage - 1) * itemsPerPage + 1, totalItems)} - {Math.min(currentPage * itemsPerPage, totalItems)} of {totalItems}
        </span>
      </div>
      
      <div className="flex items-center space-x-1">
        {/* Previous page button */}
        <button 
          onClick={() => onPageChange(currentPage - 1)} 
          disabled={currentPage === 1}
          className={`px-3 py-1 rounded ${currentPage === 1 ? 'bg-gray-800 text-gray-600' : 'bg-gray-800 text-white hover:bg-gray-700'}`}
        >
          &laquo;
        </button>
        
        {/* Page numbers */}
        {getPageNumbers().map((page, index) => (
          <button 
            key={index}
            onClick={() => typeof page === 'number' ? onPageChange(page) : null}
            disabled={page === '...'}
            className={`px-3 py-1 rounded ${
              page === currentPage 
                ? 'bg-blue-600 text-white' 
                : page === '...' 
                  ? 'bg-gray-800 text-gray-400 cursor-default'
                  : 'bg-gray-800 text-white hover:bg-gray-700'
            }`}
          >
            {page}
          </button>
        ))}
        
        {/* Next page button */}
        <button 
          onClick={() => onPageChange(currentPage + 1)} 
          disabled={currentPage === totalPages}
          className={`px-3 py-1 rounded ${currentPage === totalPages ? 'bg-gray-800 text-gray-600' : 'bg-gray-800 text-white hover:bg-gray-700'}`}
        >
          &raquo;
        </button>
      </div>
    </div>
  );
}