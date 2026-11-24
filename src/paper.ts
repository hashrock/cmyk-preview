export type Paper = 'coated' | 'matte' | 'uncoated' | 'newsprint'
export type Layout = 'auto' | 'spread' | 'single' | 'page'

export const PAPERS: { value: Paper; label: string }[] = [
  { value: 'coated', label: 'コート紙（光沢）' },
  { value: 'matte', label: 'マットコート紙' },
  { value: 'uncoated', label: '上質紙' },
  { value: 'newsprint', label: '新聞用紙' },
]
