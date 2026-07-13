export const handleResponse = (res, status, message, data = null) => {
  res.status(status).json({
    status,
    message,
    data,
  });
};

export const formatDateWithOrdinal = (date) => {
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  const formattedDate = new Intl.DateTimeFormat('en-IN', options).format(date);

  return formattedDate.replace(/\d+/, (day) => {
    if (day.endsWith('1') && day !== '11') return day + 'st';
    if (day.endsWith('2') && day !== '12') return day + 'nd';
    if (day.endsWith('3') && day !== '13') return day + 'rd';
    return day + 'th';
  });
};

export function getOrdinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export const getRiskColor = (rating) => {
  if (rating.toLowerCase() === 'high')
    return { background: 'FF0000', color: 'FFFFFF' }; // Red
  if (rating.toLowerCase() === 'medium')
    return { background: 'FFE600', color: '000000' }; // Yellow
  if (rating.toLowerCase() === 'low')
    return { background: '2DB757', color: '000000' }; // Green
  return { background: 'F2F2F2', color: '000000' }; // Default white
};

export const isValidURL = (url) => {
  const regex =
    /^(https?:\/\/)?(www\.)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d{2,5})?(\/[^\s]*)?$/;
  return regex.test(url);
};

export const formatHttpsURL = (url) => {
  try {
    const cleanURL = url.replace(/^www\./, '');

    const hasProtocol = /^https?:\/\//.test(cleanURL);
    const normalizedURL = hasProtocol ? cleanURL : `https://${cleanURL}`;

    const parsed = new URL(normalizedURL);

    return parsed.href;
  } catch {
    return url;
  }
};
