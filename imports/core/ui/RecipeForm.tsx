import React, { useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField } from '@mui/material';
import {
	formatMoney,
	parseMoneyText,
	initialRecipeData,
	parseRecipeData,
	type RecipeData,
	type RecipeDefinition
} from '../recipes/definition';
export interface RecipeFormProps {
	definition: RecipeDefinition;
	initial?: RecipeData;
	disabled?: boolean;
	text?: { save: string; saving: string; error: string };
	onSubmit: (data: RecipeData) => Promise<void>;
	onChange?: (data: RecipeData) => void;
}
/** Rendering metadata is UX only. Server repeats validation and authorization for every operation. */
export function RecipeForm({ definition, initial, disabled = false, text, onSubmit, onChange }: RecipeFormProps) {
	const [data, setData] = useState<RecipeData>(() => initial ?? initialRecipeData(definition));
	const changeData = (next: RecipeData) => {
		setData(next);
		onChange?.(next);
	};
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (pending || disabled) return;
		setPending(true);
		setError('');
		try {
			const normalized = { ...data };
			for (const field of definition.fields)
				if (field.type === 'money' && typeof normalized[field.name] === 'string')
					normalized[field.name] = parseMoneyText(normalized[field.name] as string, field.scale!);
			await onSubmit(parseRecipeData(definition, normalized));
		} catch {
			setError(text?.error ?? 'Unable to save. Check the fields and your permission, then retry.');
		} finally {
			setPending(false);
		}
	};
	return (
		<form onSubmit={submit} aria-label={`${definition.name} form`}>
			<Stack spacing={2}>
				{error && (
					<Alert severity="error" role="alert">
						{error}
					</Alert>
				)}
				{definition.fields.map((field) =>
					field.type === 'boolean' ? (
						<FormControlLabel
							key={field.name}
							label={field.label}
							control={
								<Checkbox
									checked={data[field.name] === true}
									disabled={disabled || pending}
									onChange={(e) => changeData({ ...data, [field.name]: e.target.checked })}
								/>
							}
						/>
					) : (
						<TextField
							key={field.name}
							label={field.label}
							required={field.required}
							disabled={disabled || pending}
							value={
								field.type === 'money' && typeof data[field.name] === 'number'
									? formatMoney(data[field.name] as number, field.scale!)
									: (data[field.name] ?? '')
							}
							type={field.type === 'date' ? 'date' : field.type === 'integer' ? 'number' : 'text'}
							helperText={
								field.type === 'money'
									? `${field.currency} (${field.scale} casas decimais)`
									: field.type === 'reference'
										? `ID: ${field.target}`
										: undefined
							}
							select={field.type === 'enum'}
							slotProps={{
								inputLabel: field.type === 'date' ? { shrink: true } : undefined,
								htmlInput: {
									inputMode: field.type === 'money' ? 'decimal' : undefined,
									maxLength: field.maxLength,
									min: field.min,
									max: field.max,
									step: field.type === 'integer' ? 1 : undefined
								}
							}}
							onChange={(e) =>
								changeData({
									...data,
									[field.name]:
										e.target.value === '' && !field.required
											? null
											: field.type === 'integer' && e.target.value !== ''
												? Number(e.target.value)
												: e.target.value
								})
							}>
							{field.type === 'enum' &&
								field.values!.map((v) => (
									<MenuItem key={v} value={v}>
										{v}
									</MenuItem>
								))}
						</TextField>
					)
				)}
				<Button type="submit" variant="contained" disabled={disabled || pending}>
					{pending ? (text?.saving ?? 'Saving…') : (text?.save ?? 'Save')}
				</Button>
			</Stack>
		</form>
	);
}
