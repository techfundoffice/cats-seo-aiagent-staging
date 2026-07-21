'use server'

import { saveCredentials, clearCredentials, setSetting } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function updateSettings(formData: FormData) {
  const user = formData.get('login') as string;
  const pass = formData.get('password') as string;
  if (user && pass) await saveCredentials(user, pass);

  const defaultLocation = (formData.get('default_location') as string)?.trim();
  const defaultCoordinates = (formData.get('default_coordinates') as string)?.trim();
  const defaultLanguage = (formData.get('default_language') as string)?.trim();
  const defaultDomain = (formData.get('default_domain') as string)?.trim();

  if (defaultLocation !== undefined) await setSetting('default_location', defaultLocation);
  if (defaultCoordinates !== undefined) await setSetting('default_coordinates', defaultCoordinates);
  if (defaultLanguage !== undefined) await setSetting('default_language', defaultLanguage);
  if (defaultDomain !== undefined) await setSetting('default_domain', defaultDomain);

  revalidatePath('/dashboard/settings');
}

export async function deleteCredentials() {
  await clearCredentials();
  revalidatePath('/dashboard');
  redirect('/dashboard/settings');
}
