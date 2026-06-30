import { useState, useEffect } from 'react';
import {
  ComposedModal, ModalHeader, ModalBody, ModalFooter, Modal,
  TextInput, TextArea, Toggle, Checkbox,
} from '@carbon/react';
import { Picker } from './inputs.jsx';
import { emptyValues } from '../data/formSchemas.js';

let _fid = 0;
const fid = () => { _fid += 1; return `fm-${_fid}`; };

/* Schema-driven create / edit modal. */
export function FormModal({ open, title, label, schema, initial, submitText = 'Save', onSubmit, onClose }) {
  const [vals, setVals] = useState(() => emptyValues(schema, initial));
  useEffect(() => { if (open) setVals(emptyValues(schema, initial)); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));

  const field = (f) => {
    const v = vals[f.key];
    if (f.type === 'select') {
      return <Picker key={f.key} label={f.label} items={f.items} value={v} onChange={(val) => set(f.key, val)} />;
    }
    if (f.type === 'multiselect') {
      const arr = Array.isArray(v) ? v : [];
      const toggle = (item, checked) => set(f.key, checked ? [...arr, item] : arr.filter((x) => x !== item));
      return (
        <div key={f.key}>
          <div className="cds--label" style={{ marginBottom: 6 }}>{f.label}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 20px' }}>
            {f.items.map((item) => (
              <Checkbox key={item} id={fid()} labelText={item} checked={arr.includes(item)}
                onChange={(_, { checked }) => toggle(item, checked)} />
            ))}
          </div>
        </div>
      );
    }
    if (f.type === 'textarea') {
      return <TextArea key={f.key} id={fid()} labelText={f.label} placeholder={f.placeholder} value={v} onChange={(e) => set(f.key, e.target.value)} rows={3} />;
    }
    return (
      <TextInput
        key={f.key}
        id={fid()}
        type={f.type === 'password' ? 'password' : 'text'}
        labelText={f.label}
        placeholder={f.placeholder}
        helperText={f.helper}
        value={v}
        onChange={(e) => set(f.key, e.target.value)}
      />
    );
  };

  return (
    <ComposedModal open size="sm" onClose={onClose}>
      <ModalHeader label={label} title={title} />
      <ModalBody hasForm>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {schema.map(field)}
        </div>
      </ModalBody>
      <ModalFooter
        secondaryButtonText="Cancel"
        primaryButtonText={submitText}
        onRequestClose={onClose}
        onRequestSubmit={() => onSubmit(vals)}
      />
    </ComposedModal>
  );
}

/* Carbon danger confirm dialog for destructive actions. */
export function ConfirmDelete({ open, title = 'Delete item', body = 'This action cannot be undone.', onConfirm, onClose }) {
  if (!open) return null;
  return (
    <Modal
      open
      danger
      modalHeading={title}
      primaryButtonText="Delete"
      secondaryButtonText="Cancel"
      onRequestSubmit={onConfirm}
      onRequestClose={onClose}
    >
      <p style={{ fontSize: '.875rem' }}>{body}</p>
    </Modal>
  );
}

export { TextInput, Toggle, Checkbox };
