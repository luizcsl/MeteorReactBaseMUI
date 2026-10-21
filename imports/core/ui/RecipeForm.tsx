import React, { useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField } from '@mui/material';
import { initialRecipeData, parseRecipeData, type RecipeData, type RecipeDefinition } from '../recipes/definition';
export interface RecipeFormProps {
	definition: RecipeDefinition;
	initial?: RecipeData;
	disabled?: boolean;
	onSubmit: (data: RecipeData) => Promise<void>;
}
/** Rendering metadata is UX only. Server repeats validation and authorization for every operation. */
export function RecipeForm({ definition, initial, disabled = false, onSubmit }: RecipeFormProps) {
	const [data, setData] = useState<RecipeData>(() => initial ?? initialRecipeData(definition));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (pending || disabled) return;
		setPending(true);
		setError('');
		try {
			await onSubmit(parseRecipeData(definition, data));
		} catch {
			setError('Unable to save. Check the fields and your permission, then retry.');
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
									onChange={(e) => setData({ ...data, [field.name]: e.target.checked })}
								/>
							}
						/>
					) : (
						<TextField
							key={field.name}
							label={field.label}
							required={field.required}
							disabled={disabled || pending}
							value={data[field.name] ?? ''}
							type={field.type === 'integer' ? 'number' : 'text'}
							select={field.type === 'enum'}
							slotProps={{
								htmlInput: {
									maxLength: field.maxLength,
									min: field.min,
									max: field.max,
									step: field.type === 'integer' ? 1 : undefined
								}
							}}
							onChange={(e) =>
								setData({
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
					{pending ? 'Saving…' : 'Save'}
				</Button>
			</Stack>
		</form>
	);
}
