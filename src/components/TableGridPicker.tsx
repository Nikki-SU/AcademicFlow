import { useState, useRef, useEffect } from 'react'
import { Grid3x3 } from 'lucide-react'

interface TableGridPickerProps {
  onSelect?: (rows: number, cols: number) => void
}

const MAX_ROWS = 10
const MAX_COLS = 10
const CELL_SIZE = 1.25 // rem (≈20px)

export default function TableGridPicker({ onSelect }: TableGridPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hoveredRows, setHoveredRows] = useState(0)
  const [hoveredCols, setHoveredCols] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleCellHover = (row: number, col: number) => {
    setHoveredRows(row + 1)
    setHoveredCols(col + 1)
  }

  const handleCellClick = () => {
    if (hoveredRows > 0 && hoveredCols > 0) {
      onSelect?.(hoveredRows, hoveredCols)
      setIsOpen(false)
      setHoveredRows(0)
      setHoveredCols(0)
    }
  }

  const handleMouseLeave = () => {
    setHoveredRows(0)
    setHoveredCols(0)
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 rounded-md hover:bg-slate-100 transition text-slate-600 hover:text-slate-800"
        title="插入表格"
      >
        <Grid3x3 className="w-5 h-5" />
      </button>

      {isOpen && (
        <div
          className="absolute left-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-slate-200 p-3 z-50"
          onMouseLeave={handleMouseLeave}
        >
          <div
            className="grid gap-0.5"
            style={{
              gridTemplateColumns: `repeat(${MAX_COLS}, ${CELL_SIZE}rem)`,
              gridTemplateRows: `repeat(${MAX_ROWS}, ${CELL_SIZE}rem)`,
            }}
          >
            {Array.from({ length: MAX_ROWS * MAX_COLS }).map((_, index) => {
              const row = Math.floor(index / MAX_COLS)
              const col = index % MAX_COLS
              const isHighlighted = row < hoveredRows && col < hoveredCols

              return (
                <div
                  key={index}
                  onMouseEnter={() => handleCellHover(row, col)}
                  onClick={handleCellClick}
                  className={`rounded-sm cursor-pointer transition-colors ${
                    isHighlighted
                      ? 'bg-indigo-500'
                      : 'bg-slate-200 hover:bg-slate-300'
                  }`}
                  style={{ width: `${CELL_SIZE}rem`, height: `${CELL_SIZE}rem` }}
                />
              )
            })}
          </div>

          <div className="mt-2 text-center text-sm text-slate-600 whitespace-nowrap">
            {hoveredRows > 0 && hoveredCols > 0 ? (
              <span>插入 {hoveredRows} 行 × {hoveredCols} 列的表格</span>
            ) : (
              <span>选择表格大小</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
