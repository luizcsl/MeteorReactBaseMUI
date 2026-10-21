import { legacyProjection, pickLegacySchema } from '../../../legacy/exposure';
import { exampleSch } from './exampleSch';
// Every field is explicitly included or omitted. Adding a schema key never publishes it automatically.
export const EXAMPLE_LIST_FIELDS = ['title', 'type', 'typeMulti', 'createdat'] as const;
export const EXAMPLE_LIST_OMITTED = [
	'image',
	'description',
	'check',
	'date',
	'files',
	'images',
	'audios',
	'chip',
	'contacts',
	'tasks',
	'audio',
	'address',
	'slider',
	'statusRadio',
	'statusToggle'
] as const;
export const EXAMPLE_DETAIL_FIELDS = [
	'contacts',
	'title',
	'description',
	'type',
	'typeMulti',
	'date',
	'files',
	'images',
	'audios',
	'chip',
	'statusRadio',
	'statusToggle',
	'slider',
	'check',
	'address',
	'image',
	'audio'
] as const;
export const EXAMPLE_DETAIL_OMITTED = ['tasks'] as const;
export const EXAMPLE_FORM_FIELDS = [
	'title',
	'type',
	'typeMulti',
	'description',
	'images',
	'audios',
	'files',
	'slider',
	'address',
	'check'
] as const;
export const EXAMPLE_FORM_OMITTED = [
	'image',
	'date',
	'chip',
	'contacts',
	'tasks',
	'audio',
	'statusRadio',
	'statusToggle'
] as const;
export const exampleListProjection = legacyProjection(EXAMPLE_LIST_FIELDS);
export const exampleDetailProjection = legacyProjection(EXAMPLE_DETAIL_FIELDS);
export const exampleListSchema = pickLegacySchema(
	{ ...exampleSch, createdat: { type: Date, label: 'Criado em' } },
	EXAMPLE_LIST_FIELDS
);
