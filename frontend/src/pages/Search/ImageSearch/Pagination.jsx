import { CaretLeft, CaretRight } from "@phosphor-icons/react";

export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  itemsPerPage,
  onItemsPerPageChange,
  totalItems,
}) {
  if (!totalItems || totalItems === 0) return null;

  return (
    <div className="flex items-center justify-between mt-6 px-4 py-3 bg-theme-bg-secondary rounded-lg">
      <div className="flex items-center gap-2">
        <span className="text-sm text-white/70">Items per page:</span>
        <select
          value={itemsPerPage}
          onChange={(e) => onItemsPerPageChange(Number(e.target.value))}
          className="px-3 py-1 rounded bg-theme-settings-input-bg text-white border border-white/10 focus:outline-primary-button"
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>

      <div className="flex items-center gap-4">
        <span className="text-sm text-white/70">
          {totalItems} {totalItems === 1 ? "result" : "results"}
        </span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className="p-2 rounded bg-theme-button text-white hover:bg-theme-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous page"
          >
            <CaretLeft size={16} weight="bold" />
          </button>

          <span className="text-sm text-white px-2">
            Page {currentPage} of {totalPages}
          </span>

          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className="p-2 rounded bg-theme-button text-white hover:bg-theme-button-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Next page"
          >
            <CaretRight size={16} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
