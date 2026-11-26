# TeamFlow — BGL Buy & Sell botu

PetDuel ile hiçbir bağlantısı yok. Kendi başına çalışan bir **ticket (satın alma) botu**.

## Ne yapıyor
- Bir panel atıyorsun: **Buy BGL · Sell BGL · Support** butonları.
- Müşteri butona basınca kendisine özel bir **ticket kanalı** açılıyor (sadece o kişi + yetkililer görüyor).
- Ticket içinde bot ne yazması gerektiğini söylüyor (ne kadar BGL, ödeme yöntemi, GrowID).
- Yetkili **Claim** ile üstleniyor, **Close** ile kapatıyor. Kapatınca konuşmanın kaydı (transcript) log kanalına gidiyor.
- Bot **sahte "ödeme alındı / işlem tamam" mesajı atmaz.** İşlemi yetkili elle onaylar.

## Kurulum (Discord Developer Portal)
1. https://discord.com/developers/applications → **New Application** → bir bot oluştur (PetDuel'den **ayrı** bir uygulama).
2. **Bot** sekmesi → **Reset Token** → token'ı kopyala.
3. **Privileged Gateway Intents** → **Message Content Intent** ve **Server Members Intent** AÇIK olsun.
4. **OAuth2 → URL Generator** → scopes: `bot` → izinler: **Manage Channels, Manage Roles, Read Messages, Send Messages, Manage Messages, Read Message History, Attach Files** → çıkan linkle botu sunucuna ekle.
5. Sunucuda botun rolünü **yetkili/staff rollerinin üstüne** taşı (ticket kanalı açıp kapatabilmesi için).

## Çalıştırma
- `.env.example`'ı `.env` yap, içine `DISCORD_TOKEN=...` yaz (istersen `GUILD_ID=...`).
- Bilgisayarda: klasörde `npm install` sonra `npm start`.
- Railway'de (7/24): yeni servis → bu repo → **Root Directory: `teamflow-bot`** → Variables'a `DISCORD_TOKEN` (ve istersen `GUILD_ID`) → Deploy. Ticket kayıtları kanalda durduğu için volume şart değil.

## config.json
- `brand`, `subtitle`, `currency`, `color` → görünüm.
- `ticketCategoryId` / `logChannelId` / `panelChannelId` → kanal/kategori ID'leri (Discord'da Developer Mode açıp sağ tık → Copy ID). Boşsa `channelNames`'teki isimlerle bulur.
- `staffRoleNames` → yetkili rolleri (bu roller + Manage Channels izni olanlar ticket'ı yönetir).
- `paymentMethods` → panelde ve ticket'ta yazan ödeme yöntemleri.
- `options` → panel butonları (Buy / Sell / Support), istediğini ekleyip çıkarabilirsin.
- `maxOpenTicketsPerUser` → bir kişinin aynı anda açabileceği ticket sayısı.

## Komutlar (prefix `!`)
- Yetkili: `!panel` (butonlu paneli atar) · `!close` · `!add @kişi` · `!remove @kişi` · `!help`
- Müşteriler sadece panel butonlarına basar.

## Dikkat
- BGL gibi oyun parasını gerçek para karşılığı almak/satmak genelde oyunun kurallarına aykırıdır (RMT), sorumluluk sana ait.
- Botu sahte ödeme onayı/escrow taklidi için **kullanma**; o yüzden o özellikler yok.
- Token'ı kimseyle paylaşma, `.env`'yi GitHub'a yükleme.
