/* Thin wrappers over Carbon form controls so pages can use the
   prototype's terse API (string items, value/onChange). */
import { Dropdown } from '@carbon/react';

let _seq = 0;
function nextId(prefix) { _seq += 1; return `${prefix}-${_seq}`; }

export function Picker({ label, items, value, onChange, size = 'md', id, ...rest }) {
  const fieldId = id || nextId('ip-dd');
  return (
    <Dropdown
      id={fieldId}
      size={size}
      titleText={label || ''}
      hideLabel={!label}
      label={value || 'Select'}
      items={items}
      selectedItem={value}
      itemToString={(i) => (i == null ? '' : String(i))}
      onChange={({ selectedItem }) => onChange && onChange(selectedItem)}
      {...rest}
    />
  );
}
